import assert from "node:assert/strict";
import test from "node:test";
import {
  hasChangedInside,
  normSep,
  normalizeStatusKeys,
  parentDir,
  pathKey,
  samePath,
  stripVerbatim,
  abbrevHome,
} from "../src/path-utils.ts";

test("normSep 统一反斜杠为正斜杠", () => {
  assert.equal(normSep("C:\\repo\\src\\a.ts"), "C:/repo/src/a.ts");
  assert.equal(normSep("/repo/src/a.ts"), "/repo/src/a.ts");
  // 混合分隔符（git_status_map 在 Windows 下的 join 结果）
  assert.equal(normSep("C:\\repo\\sub/file.txt"), "C:/repo/sub/file.txt");
});

test("normalizeStatusKeys 归一 git 装饰表键，值原样保留", () => {
  const norm = normalizeStatusKeys({
    "C:\\repo\\sub/file.txt": "M",
    "C:\\repo\\new.txt": "??",
  });
  assert.deepEqual(norm, {
    "C:/repo/sub/file.txt": "M",
    "C:/repo/new.txt": "??",
  });
  // 归一后的键能被归一后的 entry.path（list_dir 全 \）命中
  assert.equal(norm[normSep("C:\\repo\\sub\\file.txt")], "M");
});

test("hasChangedInside 用归一前缀匹配目录内变更", () => {
  const map = normalizeStatusKeys({
    "C:\\repo\\src/a.ts": "M",
  });
  assert.equal(hasChangedInside(map, "C:\\repo\\src"), true);
  assert.equal(hasChangedInside(map, "C:\\repo"), true);
  assert.equal(hasChangedInside(map, "C:\\repo\\docs"), false);
  // 前缀必须落在路径段边界上：src2 不算 src 内
  const map2 = normalizeStatusKeys({ "C:\\repo\\src2\\b.ts": "M" });
  assert.equal(hasChangedInside(map2, "C:\\repo\\src"), false);
});

test("parentDir 常规与根边界", () => {
  assert.equal(parentDir("/a/b"), "/a");
  assert.equal(parentDir("/a"), "/");
  assert.equal(parentDir("/"), null);
  assert.equal(parentDir("~"), null);
  assert.equal(parentDir("/a/b/"), "/a");
});

test("parentDir Windows 盘符边角", () => {
  assert.equal(parentDir("C:\\foo"), "C:\\");
  assert.equal(parentDir("C:/foo"), "C:/");
  assert.equal(parentDir("C:\\foo\\bar"), "C:\\foo");
  // 盘符根无法再上
  assert.equal(parentDir("C:\\"), null);
  assert.equal(parentDir("C:"), null);
  assert.equal(parentDir("D:\\a\\b\\c"), "D:\\a\\b");
});

test("stripVerbatim 剥掉 Windows canonicalize 的 verbatim 前缀", () => {
  assert.equal(stripVerbatim("\\\\?\\C:\\Users\\x"), "C:\\Users\\x");
  assert.equal(stripVerbatim("\\\\?\\UNC\\srv\\share\\p"), "\\\\srv\\share\\p");
  // 普通路径恒等（macOS 上本函数不做任何事）
  assert.equal(stripVerbatim("C:\\Users\\x"), "C:\\Users\\x");
  assert.equal(stripVerbatim("/Users/x"), "/Users/x");
});

test("pathKey 折叠 verbatim/分隔符/尾斜杠；大小写只在 Windows 折叠", () => {
  // 回归：后端 canonical_key 曾把 \\?\C:\... 落库，与前端手里的普通形式永不相等 ⇒
  // 已注册项目的会话被当成「随手聊」、项目根会话没有「查看项目」按钮
  assert.equal(pathKey("\\\\?\\C:\\Users\\x"), pathKey("C:\\Users\\x"));
  assert.equal(pathKey("C:\\Users\\x"), pathKey("C:/Users/x"));
  assert.equal(pathKey("/Users/x/"), pathKey("/Users/x"));
  // POSIX 上大小写有意义，不能折叠
  assert.notEqual(pathKey("/Users/Foo"), pathKey("/users/foo"));
  assert.ok(!samePath("/Users/Foo", "/users/foo"));
  // Windows 侧显式传参：NTFS 大小写不敏感
  assert.equal(pathKey("C:\\Users\\Foo", true), pathKey("c:/users/foo", true));
  assert.ok(samePath("\\\\?\\C:\\Users\\Foo", "c:\\users\\foo", true));
});

test("abbrevHome 把家目录前缀折成 ~", () => {
  assert.equal(abbrevHome("/Users/me/src", "/Users/me"), "~/src");
  assert.equal(abbrevHome("/Users/me", "/Users/me"), "~");
  assert.equal(abbrevHome("/opt/app", "/Users/me"), "/opt/app");
  assert.equal(
    abbrevHome("C:\\Users\\me\\src", "C:\\Users\\me", true),
    "~/src",
  );
});
