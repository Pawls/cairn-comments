/** The task file: repositories, their base commits, and the tasks run against them. */
import { readFileSync } from "node:fs";
import path from "node:path";

export interface RepoSpec {
  url: string;
  /** The commit the frozen comments were written at; it precedes every task's start. */
  base: string;
  /** Shell commands run in each fresh checkout before the agent starts. */
  setup: string[];
}

interface TaskBase {
  id: string;
  repo: string;
  /** The commit the agent starts from. */
  start: string;
  prompt: string;
}

export interface EditTask extends TaskBase {
  kind: "fix" | "feature";
  /** The commit whose `testFiles` grade the run. */
  solution: string;
  testFiles: string[];
  /** Shell command, run from the checkout's root, that passes when the task is done. */
  testCommand: string;
}

export interface QuestionTask extends TaskBase {
  kind: "question";
  /** Patterns a correct answer matches, all of them (see `gradeAnswer`). */
  answerKey: string[];
}

export type Task = EditTask | QuestionTask;

export interface TaskFile {
  repos: Record<string, RepoSpec>;
  tasks: Task[];
}

/** A setup or test command with `{venv-python}` replaced by the checkout's virtualenv interpreter. */
export function expandCommand(command: string): string {
  const venvPython = process.platform === "win32" ? path.join(".venv", "Scripts", "python.exe") : ".venv/bin/python";
  return command.replaceAll("{venv-python}", venvPython);
}

export function loadTasks(file: string): TaskFile {
  const parsed = JSON.parse(readFileSync(file, "utf8")) as TaskFile;
  for (const task of parsed.tasks) {
    if (!parsed.repos[task.repo]) throw new Error(`task ${task.id}: unknown repo ${task.repo}`);
  }
  return parsed;
}
