import assert from "node:assert/strict";
import test from "node:test";
import { createSessionRefreshCoordinator } from "../src/session-refresh.ts";
import {
  directoryErrorMessage,
  directoryUnavailableMessage,
  isDirectoryUnavailableError,
} from "../src/terminal-cwd.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("普通刷新复用在途请求", async () => {
  const first = deferred<string[]>();
  let calls = 0;
  let current: string[] = [];
  const refresh = createSessionRefreshCoordinator(
    () => {
      calls += 1;
      return first.promise;
    },
    () => current,
    (next) => {
      current = next;
    },
  );

  const a = refresh.load();
  const b = refresh.load();
  assert.strictEqual(a, b);
  assert.equal(calls, 1);
  first.resolve(["new"]);
  assert.deepEqual(await a, ["new"]);
  assert.deepEqual(current, ["new"]);
});

test("强制刷新开启新代次，旧结果不能覆盖新列表", async () => {
  const oldRequest = deferred<string[]>();
  const newRequest = deferred<string[]>();
  let calls = 0;
  let current = ["initial"];
  const refresh = createSessionRefreshCoordinator(
    () => {
      calls += 1;
      return calls === 1 ? oldRequest.promise : newRequest.promise;
    },
    () => current,
    (next) => {
      current = next;
    },
  );

  const oldResult = refresh.load();
  const latestResult = refresh.load(true);
  assert.equal(calls, 2);
  oldRequest.resolve(["stale"]);
  let oldSettled = false;
  void oldResult.then(() => {
    oldSettled = true;
  });
  await Promise.resolve();
  assert.equal(oldSettled, false);
  assert.deepEqual(current, ["initial"]);
  newRequest.resolve(["latest"]);
  assert.deepEqual(await latestResult, ["latest"]);
  assert.deepEqual(await oldResult, ["latest"]);
  assert.deepEqual(current, ["latest"]);
});

test("旧请求失败时，旧调用者仍等待最新列表", async () => {
  const oldRequest = deferred<string[]>();
  const newRequest = deferred<string[]>();
  let calls = 0;
  let current = ["initial"];
  const refresh = createSessionRefreshCoordinator(
    () => {
      calls += 1;
      return calls === 1 ? oldRequest.promise : newRequest.promise;
    },
    () => current,
    (next) => {
      current = next;
    },
  );

  const oldResult = refresh.load();
  const latestResult = refresh.load(true);
  oldRequest.reject(new Error("stale failure"));
  await Promise.resolve();
  newRequest.resolve(["latest"]);

  assert.deepEqual(await latestResult, ["latest"]);
  assert.deepEqual(await oldResult, ["latest"]);
  assert.deepEqual(current, ["latest"]);
});

test("失效目录错误转为可恢复的人话", () => {
  assert.equal(isDirectoryUnavailableError("读取目录失败: No such file or directory (os error 2)"), true);
  assert.equal(directoryUnavailableMessage("/tmp/missing"), "目录不存在或已移动：/tmp/missing");
  assert.equal(
    directoryErrorMessage("读取目录失败: Permission denied", "/tmp/private"),
    "目录不可用：Permission denied",
  );
});
