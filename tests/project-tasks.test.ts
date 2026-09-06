import test from "node:test";
import assert from "node:assert/strict";
import {
  canSubmitDeclaredTask,
  declaredTaskKindsForMode,
  isDeclaredTask,
  isDeclaredTaskName,
  isTaskMaterialNoise,
  joinRunPath,
  pathCoveredBySelection,
  pruneNestedPaths,
  relativeProjectPath,
  selectedChangePaths,
  taskChangeKindLabel,
  taskFileBadge,
  taskInputLabel,
  taskOutputLabel,
  taskPathsForScope,
  taskStatusLabel,
  toggleTaskMaterialPath,
  visibleDeclaredTasks,
} from "../src/project-tasks.ts";

test("write tasks do not silently default to the whole project", () => {
  assert.deepEqual(taskPathsForScope("none", [], "write_tree"), {
    inputPaths: [],
    outputPaths: ["."],
    error: null,
  });
  assert.deepEqual(taskPathsForScope("whole", ["notes"], "write_tree"), {
    inputPaths: ["."],
    outputPaths: ["."],
    error: null,
  });
  assert.deepEqual(taskPathsForScope("selected", [], "write_tree").error, "请勾选要带入这一步的文件或目录");
  assert.deepEqual(taskPathsForScope("selected", ["notes/a.md", "notes"], "write_tree"), {
    inputPaths: ["notes"],
    outputPaths: ["."],
    error: null,
  });
  assert.deepEqual(taskPathsForScope("selected", ["papers/a.pdf"], "discuss"), {
    inputPaths: ["papers/a.pdf"],
    outputPaths: [],
    error: null,
  });
});

test("pruneNestedPaths keeps the parent and drops children", () => {
  assert.deepEqual(pruneNestedPaths(["notes/a.md", "notes", "notes/b.md"]), ["notes"]);
  assert.deepEqual(pruneNestedPaths([".", "notes"]), ["."]);
  assert.deepEqual(pruneNestedPaths(["papers/a.pdf", "notes"]), ["notes", "papers/a.pdf"]);
});

test("toggleTaskMaterialPath selects a folder without keeping nested files", () => {
  assert.deepEqual(
    toggleTaskMaterialPath(["notes/a.md", "papers/a.pdf"], "notes", true),
    ["notes", "papers/a.pdf"],
  );
  assert.deepEqual(toggleTaskMaterialPath(["notes", "papers/a.pdf"], "notes", false), [
    "papers/a.pdf",
  ]);
  assert.deepEqual(toggleTaskMaterialPath(["notes"], "notes/a.md", true), ["notes"]);
});

test("pathCoveredBySelection treats selected folders as covering descendants", () => {
  assert.equal(pathCoveredBySelection("notes/a.md", ["notes"]), true);
  assert.equal(pathCoveredBySelection("notes", ["notes"]), true);
  assert.equal(pathCoveredBySelection("src/main.ts", ["notes"]), false);
  assert.equal(pathCoveredBySelection("notes/a.md", ["."]), true);
});

test("declared tasks hide path-named conversation wrappers", () => {
  assert.equal(isDeclaredTaskName("整理筛选清单"), true);
  assert.equal(isDeclaredTaskName("/Users/me/proj/综述文献"), false);
  assert.equal(isDeclaredTaskName("C:\\Users\\me\\proj"), false);
  assert.equal(isDeclaredTaskName("~\\ccode\\scratch"), false);
  assert.equal(isDeclaredTask({ declared: true, name: "/tmp/x" }), true);
  assert.equal(isDeclaredTask({ declared: false, name: "整理筛选清单" }), false);
  assert.equal(isDeclaredTask({ name: "/Users/me/proj" }), false);
  assert.deepEqual(
    visibleDeclaredTasks(
      [
        { kind: "free_research", name: "整理筛选清单", declared: true },
        { kind: "free_research", name: "/Users/me/proj", declared: false },
        { kind: "office_doc", name: "改周报", declared: true },
        { kind: "pipeline_step", name: "文献精读", declared: true },
      ],
      new Set(["free_research", "office_doc"]),
    ).map((task) => task.name),
    ["整理筛选清单", "改周报"],
  );
});

test("declaredTaskKindsForMode only office and lite research use declared tasks", () => {
  assert.deepEqual([...declaredTaskKindsForMode("office")], ["office_doc"]);
  assert.deepEqual([...declaredTaskKindsForMode("research")], ["free_research"]);
  assert.equal(declaredTaskKindsForMode("coding").size, 0);
  assert.equal(taskStatusLabel("pending_review"), "待审核");
});

test("canSubmitDeclaredTask requires a name, profile, and explicit materials", () => {
  assert.equal(
    canSubmitDeclaredTask({
      name: "整理筛选清单",
      scope: "selected",
      selectedPaths: ["papers/included.md"],
      profileId: "p1",
      permission: "write_tree",
    }),
    true,
  );
  assert.equal(
    canSubmitDeclaredTask({
      name: "整理筛选清单",
      scope: "selected",
      selectedPaths: [],
      profileId: "p1",
      permission: "write_tree",
    }),
    false,
  );
  assert.equal(
    canSubmitDeclaredTask({
      name: "空副本起草",
      scope: "none",
      selectedPaths: [],
      profileId: "p1",
      permission: "write_tree",
    }),
    true,
  );
});

test("task labels stay human for scoped materials and discuss", () => {
  assert.equal(taskInputLabel(["."]), "整个项目");
  assert.equal(taskInputLabel([]), "不带入现有文件");
  assert.equal(taskInputLabel(["notes", "papers/a.pdf"]), "notes、papers/a.pdf");
  assert.equal(taskOutputLabel(["."], true), "审核后写回项目");
  assert.equal(taskOutputLabel([], false), "只讨论，不改项目文件");
  assert.equal(taskChangeKindLabel("added"), "新增");
  assert.equal(taskChangeKindLabel("modified"), "修改");
});

test("isTaskMaterialNoise skips VCS, Ccode, and dependency directories", () => {
  assert.equal(isTaskMaterialNoise(".git"), true);
  assert.equal(isTaskMaterialNoise("Library", true), true);
  assert.equal(isTaskMaterialNoise("notes"), false);
});

test("selectedChangePaths keeps list order and drops unchecked rows", () => {
  assert.deepEqual(
    selectedChangePaths(
      [{ path: "notes/a.md" }, { path: "notes/b.md" }, { path: "notes/c.md" }],
      new Set(["notes/c.md", "notes/a.md"]),
    ),
    ["notes/a.md", "notes/c.md"],
  );
});

test("relativeProjectPath strips the project root across separators", () => {
  assert.equal(
    relativeProjectPath("/Users/me/proj", "/Users/me/proj/notes/a.md"),
    "notes/a.md",
  );
  assert.equal(
    relativeProjectPath("C:\\Users\\me\\proj", "C:\\Users\\me\\proj\\notes\\a.md"),
    "notes/a.md",
  );
});

test("taskFileBadge only marks specific outputs, not whole-project scope", () => {
  assert.equal(taskFileBadge(["."], "notes/a.md"), null);
  assert.equal(taskFileBadge(["notes/a.md"], "notes/a.md"), "notes/a.md");
  assert.equal(taskFileBadge(["notes"], "notes/a.md"), "notes");
  assert.equal(taskFileBadge(["notes/a.md"], "src/main.ts"), null);
});

test("joinRunPath keeps isolation files addressable", () => {
  assert.equal(
    joinRunPath("/tmp/task-runs/abc", "notes/a.md"),
    "/tmp/task-runs/abc/notes/a.md",
  );
  assert.equal(joinRunPath("/tmp/task-runs/abc/", ""), "/tmp/task-runs/abc");
});
