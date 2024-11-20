import { readFileSync } from "fs";
import * as core from "@actions/core";
import OpenAI from "openai";
import { Octokit } from "@octokit/rest";
import parseDiff, { Chunk, File } from "parse-diff";
import minimatch from "minimatch";

const GITHUB_TOKEN: string = core.getInput("GITHUB_TOKEN");
const OPENAI_API_KEY: string = core.getInput("OPENAI_API_KEY");
const OPENAI_API_MODEL: string = core.getInput("OPENAI_API_MODEL");
const CUSTOM_PROMPT: string = core.getInput("prompt");

const octokit = new Octokit({ auth: GITHUB_TOKEN });

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

interface PRDetails {
  owner: string;
  repo: string;
  pull_number: number;
  title: string;
  description: string;
}

/**
 * Queue implementation to manage requests
 */
class RequestQueue {
  private queue: (() => Promise<any>)[] = [];
  private active = false;

  add(request: () => Promise<any>) {
    this.queue.push(request);
    this.processQueue();
  }

  private async processQueue() {
    if (this.active || this.queue.length === 0) return;

    this.active = true;
    const request = this.queue.shift();
    if (request) {
      try {
        await request();
      } catch (error) {
        console.error("Error processing request in queue:", error);
      }
    }
    this.active = false;
    this.processQueue(); // Process the next request
  }
}

const requestQueue = new RequestQueue();

async function getPRDetails(): Promise<PRDetails> {
  const { repository, number } = JSON.parse(
    readFileSync(process.env.GITHUB_EVENT_PATH || "", "utf8")
  );
  const prResponse = await octokit.pulls.get({
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: number,
  });
  return {
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: number,
    title: prResponse.data.title ?? "",
    description: prResponse.data.body ?? "",
  };
}

async function getDiff(
  owner: string,
  repo: string,
  pull_number: number
): Promise<string | null> {
  const response = await octokit.pulls.get({
    owner,
    repo,
    pull_number,
    mediaType: { format: "diff" },
  });
  // @ts-expect-error - response.data is a string
  return response.data;
}

async function analyzeCode(
  parsedDiff: File[],
  prDetails: PRDetails
): Promise<Array<{ body: string; path: string; line: number }>> {
  const comments: Array<{ body: string; path: string; line: number }> = [];

  for (const file of parsedDiff) {
    if (!file.to || file.to === "/dev/null") {
      console.warn(`Skipping deleted or invalid file: ${file.to}`);
      continue;
    }

    for (const chunk of file.chunks) {
      const prompt = createPrompt(file, chunk, prDetails);

      try {
        const aiResponse = await getAIResponse(prompt);
        if (aiResponse) {
          const newComments = createComment(file, chunk, aiResponse);
          comments.push(...newComments);
        }
      } catch (error) {
        console.error(`Error processing file: ${file.to}, Error:`, error);
      }
    }
  }

  return comments;
}

function createPrompt(file: File, chunk: Chunk, prDetails: PRDetails): string {
  const defaultPrompt = `Your task is to review pull requests. Instructions:
                        - Provide comments and suggestions ONLY if there is something to improve.
                        - Provide the response in JSON format: {"reviews": [{"lineNumber": <line_number>, "reviewComment": "<review comment>"}]}`;
  const prompt = CUSTOM_PROMPT ? CUSTOM_PROMPT : defaultPrompt;
  return `${prompt}
Review the following code diff in the file "${file.to}" with the PR title "${prDetails.title}":
\`\`\`diff
${chunk.content}
\`\`\`
`;
}

async function getAIResponse(prompt: string): Promise<Array<{
  lineNumber: string;
  reviewComment: string;
}> | null> {
  const queryConfig = {
    model: OPENAI_API_MODEL,
    temperature: 0.2,
    max_tokens: 700,
    top_p: 1,
    frequency_penalty: 0,
    presence_penalty: 0,
  };

  try {
    // Log nội dung prompt gửi tới OpenAI
    console.log("Prompt sent to OpenAI:\n", prompt);

    const response = await openai.chat.completions.create({
      ...queryConfig,
      messages: [
        {
          role: "system",
          content: prompt,
        },
      ],
    });

    // Log phản hồi từ OpenAI trước khi xử lý
    console.log("Response received from OpenAI:\n", response);

    const removeMarkdown = (input: any) => {
      return input.replace(/```json([\s\S]*?)```/g, '$1').trim();
    };

    const res = response.choices[0].message?.content?.trim() || "{}";

    try {
      const parsedResponse = JSON.parse(removeMarkdown(res));
      console.log("Parsed JSON response:\n", parsedResponse); // Log phản hồi JSON đã parse
      return parsedResponse.reviews;
    } catch (jsonError) {
      console.error("Error parsing JSON response:", res); // Log lỗi JSON không hợp lệ
      throw new Error(`Invalid JSON format received: ${res}`);
    }
  } catch (error) {
    console.error("Error calling OpenAI API:", error); // Log lỗi từ OpenAI API
    return null;
  }
}


function createComment(
  file: File,
  chunk: Chunk,
  aiResponses: Array<{
    lineNumber: string;
    reviewComment: string;
  }>
): Array<{ body: string; path: string; line: number }> {
  return aiResponses.map((aiResponse) => ({
    body: aiResponse.reviewComment,
    path: file.to || "",
    line: Number(aiResponse.lineNumber),
  }));
}

async function createReviewComment(
  owner: string,
  repo: string,
  pull_number: number,
  comments: Array<{ body: string; path: string; line: number }>
): Promise<void> {
  console.log(`Creating review comments for PR: ${pull_number}`);
  console.log(`Number of comments: ${comments.length}`);
  
  const { data: commits } = await octokit.pulls.listCommits({
    owner,
    repo,
    pull_number,
  });
  const commitId = commits[commits.length - 1].sha;
  
  for (const comment of comments) {
    console.log(`Adding comment: ${comment.body} on line ${comment.line}`);
    try {
      await octokit.pulls.createReviewComment({
        owner,
        repo,
        pull_number,
        commit_id: commitId,
        body: comment.body,
        path: comment.path,
        line: comment.line,
      });
    } catch (error) {
      console.error("Error submitting comment:", comment, error);
    }
  }
}

async function main() {
  const prDetails = await getPRDetails();
  let diff: string | null;
  const eventData = JSON.parse(
    readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8")
  );

  if (eventData.action === "opened") {
    diff = await getDiff(prDetails.owner, prDetails.repo, prDetails.pull_number);
  } else if (eventData.action === "synchronize") {
    const newBaseSha = eventData.before;
    const newHeadSha = eventData.after;

    const response = await octokit.repos.compareCommits({
      headers: {
        accept: "application/vnd.github.v3.diff",
      },
      owner: prDetails.owner,
      repo: prDetails.repo,
      base: newBaseSha,
      head: newHeadSha,
    });

    diff = String(response.data);
  } else {
    console.log("Unsupported event:", eventData.action);
    return;
  }

  if (!diff) {
    console.log("No diff found");
    return;
  }

  const parsedDiff = parseDiff(diff);
  const comments = await analyzeCode(parsedDiff, prDetails);

  if (comments.length > 0) {
    await createReviewComment(prDetails.owner, prDetails.repo, prDetails.pull_number, comments);
  }
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
