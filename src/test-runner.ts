import { spawn } from "node:child_process";

export interface TestResult { command: string; passed: boolean; output: string; exitCode: number | null; }
export interface CommandRunner { run(command: string, cwd: string, timeoutMs?: number): Promise<TestResult>; }
export class ShellTestRunner implements CommandRunner {
  async run(command: string, cwd: string, timeoutMs = 120_000): Promise<TestResult> {
    return new Promise((resolveResult) => {
      const child = spawn(command, { cwd, shell: true, stdio: ["ignore", "pipe", "pipe"] });
      let output = ""; child.stdout.on("data", (x) => { output += x; }); child.stderr.on("data", (x) => { output += x; });
      const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
      child.on("close", (code) => { clearTimeout(timer); resolveResult({ command, passed: code === 0, output, exitCode: code }); });
      child.on("error", (error) => { clearTimeout(timer); resolveResult({ command, passed: false, output: error.message, exitCode: null }); });
    });
  }
}
export async function runTests(runner: CommandRunner, commands: string[], cwd: string): Promise<TestResult[]> {
  const results: TestResult[] = [];
  for (const command of commands) results.push(await runner.run(command, cwd));
  return results;
}
