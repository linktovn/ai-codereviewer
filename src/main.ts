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
          if (newComments.length > 0) {
            comments.push(...newComments);
          } else {
            console.warn(`No valid comments created for file: ${file.to}, chunk: ${chunk.content}`);
          }
        } else {
          console.warn(`AI response is null or empty for file: ${file.to}`);
        }
      } catch (error) {
        console.error(`Error processing file: ${file.to}, chunk: ${chunk.content}, Error:`, error);
      }
    }
  }

  return comments;
}

function createPrompt(file: File, chunk: Chunk, prDetails: PRDetails): string {
  const defaultPrompt = `Your task is to review pull requests. Instructions:
                        - Do not give positive comments or compliments.
                        - Provide comments and suggestions ONLY if there is something to improve, otherwise "reviews" should be an empty array.
                        - Write the comment in GitHub Markdown format.
                        - Use the given description only for the overall context and only comment the code.
                        - IMPORTANT: NEVER suggest adding comments to the code.`
  const prompt = `${CUSTOM_PROMPT ? CUSTOM_PROMPT : defaultPrompt}
                  - Provide the response in following JSON format:  {"reviews": [{"lineNumber":  <line_number>, "reviewComment": "<review comment>"}]}
                  `;
  return `${prompt}
Review the following code diff in the file "${
    file.to
  }" and take the pull request title and description into account when writing the response.
  
Pull request title: ${prDetails.title}
Pull request description:

---
${prDetails.description}
---

Git diff to review:

\`\`\`diff
${chunk.content}
${chunk.changes
  // @ts-expect-error - ln and ln2 exists where needed
  .map((c) => `${c.ln ? c.ln : c.ln2} ${c.content}`)
  .join("\n")}
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
    // console.log("Prompt sent to OpenAI:\n", prompt); // Log prompt gửi đến OpenAI

    const response = await openai.chat.completions.create({
      ...queryConfig,
      ...(OPENAI_API_MODEL === "gpt-4-1106-preview"
        ? { response_format: { type: "json_object" } }
        : {}),
      messages: [
        {
          role: "system",
          content: prompt,
        },
      ],
    });

    // console.log("Response received from OpenAI:\n", response); // Log phản hồi thô từ OpenAI

    const res = response.choices[0].message?.content?.trim() || "{}";

    try {
      const parsedResponse = JSON.parse(res);
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
  return aiResponses.flatMap((aiResponse) => {
    // Bỏ qua nếu `file.to` không tồn tại
    if (!file.to) {
      console.warn(`Skipping invalid file path: ${file.to}`);
      return [];
    }

    // Xác nhận `lineNumber` có tồn tại trong `chunk.changes`
    const isValidLineNumber = chunk.changes.some(
      (change: { ln?: number; ln2?: number; content: string }) =>
        change.ln === Number(aiResponse.lineNumber) || change.ln2 === Number(aiResponse.lineNumber)
    );

    if (!isValidLineNumber) {
      console.warn(
        `Invalid lineNumber ${aiResponse.lineNumber} for file ${file.to}. It does not exist in the diff hunk.`
      );
      return [];
    }

    return {
      body: aiResponse.reviewComment,
      path: file.to,
      line: Number(aiResponse.lineNumber),
    };
  });
}

async function createReviewComment(
  owner: string,
  repo: string,
  pull_number: number,
  comments: Array<{ body: string; path: string; line: number }>
): Promise<void> {
  await octokit.pulls.createReview({
    owner,
    repo,
    pull_number,
    comments,
    event: "COMMENT",
  });
}

async function main() {
  const prDetails = await getPRDetails();
  let diff: string | null;
  const eventData = JSON.parse(
    readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8")
  );

  if (eventData.action === "opened") {
    diff = await getDiff(
      prDetails.owner,
      prDetails.repo,
      prDetails.pull_number
    );
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
    console.log("Unsupported event:", process.env.GITHUB_EVENT_NAME);
    return;
  }

  if (!diff) {
    console.log("No diff found");
    return;
  }

  const parsedDiff = parseDiff(diff);

  const excludePatterns = core
    .getInput("exclude")
    .split(",")
    .map((s) => s.trim());

  const filteredDiff = parsedDiff.filter((file) => {
    return !excludePatterns.some((pattern) =>
      minimatch(file.to ?? "", pattern)
    );
  });

  const comments = await analyzeCode(filteredDiff, prDetails);
  if (comments.length > 0) {
    const limitedComments = limitComments(comments);
    await createReviewComment(prDetails.owner, prDetails.repo, prDetails.pull_number, limitedComments);
  }
}
const MAX_COMMENTS = 10;

function limitComments(comments: Array<{ body: string; path: string; line: number }>): Array<{ body: string; path: string; line: number }> {
  if (comments.length > MAX_COMMENTS) {
    console.warn(`Limiting comments to ${MAX_COMMENTS}`);
    return comments.slice(0, MAX_COMMENTS);
  }
  return comments;
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
