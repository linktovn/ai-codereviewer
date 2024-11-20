
import { readFileSync } from "fs";
import * as core from "@actions/core";
import OpenAI from "openai";
import { Octokit } from "@octokit/rest";
import parseDiff, { Chunk, File } from "parse-diff";
import minimatch from "minimatch";
import pLimit from "p-limit"; // Added for pooling requests

const GITHUB_TOKEN: string = core.getInput("GITHUB_TOKEN");
const OPENAI_API_KEY: string = core.getInput("OPENAI_API_KEY");
const OPENAI_API_MODEL: string = core.getInput("OPENAI_API_MODEL");
const CUSTOM_PROMPT: string = core.getInput("prompt");

const octokit = new Octokit({ auth: GITHUB_TOKEN });

// Create a limit for concurrent requests
const limit = pLimit(5); // Maximum 5 concurrent requests

/**
 * Function to process GitHub requests with pooling
 */
const sendRequest = async (request: () => Promise<any>) => {
  return limit(() => request());
};

/**
 * Example usage: Sending requests with pooling
 * Replace these requests with your actual logic
 */
const exampleRequests = [
  async () => octokit.rest.issues.createComment({ 
    owner: "owner", 
    repo: "repo", 
    issue_number: 1, 
    body: "This is a comment."
  }),
  async () => octokit.rest.pulls.createReview({ 
    owner: "owner", 
    repo: "repo", 
    pull_number: 1, 
    event: "COMMENT", 
    body: "This is a review."
  }),
  // Add more requests here
];

const processRequests = async () => {
  try {
    const results = await Promise.all(exampleRequests.map(sendRequest));
    console.log("All requests processed:", results);
  } catch (error) {
    console.error("Error processing requests:", error);
  }
};

// Call the function to process the requests
processRequests();
