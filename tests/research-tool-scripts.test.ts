import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const python = process.platform === "win32" ? "python" : "python3";
const bridge = resolve("src-tauri/resources/skills/endnote-bridge/scripts/bridge.py");
const citeDocx = resolve("src-tauri/resources/skills/endnote-bridge/scripts/cite_docx.py");
const run = (script: string, args: string[]) => spawnSync(python, [script, ...args], { encoding: "utf8", timeout: 20_000 });

test("EndNote bridge converts XML/RIS/BibTeX and preserves stable keys without changing original", () => {
  const root = mkdtempSync(join(tmpdir(), "mesa-bib-bridge-"));
  try {
    const input = join(root, "source.bib");
    const text = "@article{ExistingKey,\n title={结构 & Evidence}, author={Doe, Jane and Hong, Tongzhou}, year={2026}, journal={Research}, doi={10.1/example}, volume={12}, number={3}, pages={1--8}, url={https://example.test}, isbn={123}\n}\n";
    writeFileSync(input, text);
    const xml = join(root, "export.xml");
    let result = run(bridge, ["--input", input, "--output", xml, "--report", join(root, "first.json")]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(xml,"utf8"), /结构 &amp; Evidence/);
    const back = join(root, "candidate.bib");
    result = run(bridge, ["--input", xml, "--existing", input, "--output", back, "--report", join(root, "second.json")]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(back,"utf8"), /ExistingKey/);
    for (const expected of ["volume = {12}", "pages = {1--8}", "doi = {10.1/example}", "Hong, Tongzhou"]) assert.ok(readFileSync(back,"utf8").includes(expected), expected);
    assert.equal(readFileSync(input,"utf8"), text);
    const ris = join(root, "export.ris");
    result = run(bridge, ["--input", xml, "--output", ris, "--report", join(root, "third.json")]);
    assert.equal(result.status, 0, result.stderr);
    result = run(bridge, ["--input", ris, "--output", join(root, "ris.json"), "--report", join(root, "fourth.json")]);
    assert.equal(result.status, 0, result.stderr);
    const records = JSON.parse(readFileSync(join(root,"ris.json"),"utf8"));
    assert.equal(records[0].id, "ExistingKey");
    assert.deepEqual(records[0].authors, ["Doe, Jane", "Hong, Tongzhou"]);
    assert.equal(records[0].pages, "1--8");
    const before = readFileSync(xml,"utf8");
    result = run(bridge, ["--input", input, "--output", xml, "--report", join(root, "overwrite.json")]);
    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(xml,"utf8"), before);
  } finally { rmSync(root,{recursive:true,force:true}); }
});

test("EndNote rejects malformed input, macro loss, external entities and report/output alias", () => {
  const root = mkdtempSync(join(tmpdir(), "mesa-bib-errors-"));
  try {
    for (const [name, text] of [["bad.bib","@article{x,title={oops}"], ["macro.bib","@string{j=\"Journal\"}\n@article{x,title={A},journal=j}"], ["evil.xml","<!DOCTYPE x [<!ENTITY e SYSTEM 'file:///etc/passwd'>]><xml/>"], ["bad.ris","TY  - JOUR\nTI  - A\n"]]) {
      const path = join(root,name); writeFileSync(path,text);
      const out = join(root,name+".xml");
      const result = run(bridge,["--input",path,"--output",out,"--report",out+".json"]);
      assert.notEqual(result.status,0,name);assert.equal(existsSync(out),false);
    }
    const source=join(root,"valid.bib");writeFileSync(source,"@article{x,title={A},year={2026}}");
    const alias=join(root,"same.xml");
    assert.notEqual(run(bridge,["--input",source,"--output",alias,"--report",alias]).status,0);
    assert.equal(existsSync(alias),false);
  } finally { rmSync(root,{recursive:true,force:true}); }
});

test("EndNote 域稿：匹配键写出 ADDIN EN.CITE，未匹配不写 docx", () => {
  const root = mkdtempSync(join(tmpdir(), "mesa-endnote-cite-"));
  try {
    const md = join(root, "review-final.md");
    const bib = join(root, "references.bib");
    writeFileSync(
      bib,
      "@article{Doe2020,\n title={Evidence}, author={Doe, Jane and Roe, John}, year={2020}, journal={Research}, doi={10.1/ex}\n}\n@article{Lee2021,\n title={More}, author={Lee, Ann}, year={2021}, journal={Research}\n}\n",
    );
    writeFileSync(
      md,
      "# Title\n\nSee [@Doe2020] and also [@Doe2020; @Lee2021].\n\n```\ncode [@Missing]\n```\n",
    );
    const docx = join(root, "endnote.docx");
    const report = join(root, "report.md");
    let result = run(citeDocx, ["--input", md, "--bib", bib, "--output", docx, "--report", report]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(docx), true);
    const zip = spawnSync(python, ["-c", "import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); print(z.read('word/document.xml').decode())", docx], { encoding: "utf8", timeout: 10_000 });
    assert.equal(zip.status, 0, zip.stderr);
    assert.match(zip.stdout, /ADDIN EN\.CITE/);
    assert.match(zip.stdout, /ADDIN EN\.REFLIST/);
    assert.doesNotMatch(zip.stdout, /\{Doe, 2020/);
    assert.match(zip.stdout, /Doe et al\., 2020/);
    assert.doesNotMatch(zip.stdout, /<Author>Missing<\/Author>/);
    assert.match(readFileSync(report, "utf8"), /未匹配：0/);

    writeFileSync(md, "Broken [@NoSuchKey] cite.\n");
    const bad = join(root, "bad.docx");
    result = run(citeDocx, ["--input", md, "--bib", bib, "--output", bad, "--report", join(root, "bad.md")]);
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(bad), false);
    assert.match(readFileSync(join(root, "bad.md"), "utf8"), /NoSuchKey/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("引用样式按 PDF 推荐，不替人选定；EndNote 同步只应用接受的删除和新文献", () => {
  const root = mkdtempSync(join(tmpdir(), "mesa-cite-style-"));
  try {
    const papers = join(root, "papers");
    const manuscript = join(root, "manuscript");
    mkdirSync(papers);
    mkdirSync(manuscript);
    const stream = Buffer.from("BT (See [1] and [2].) Tj ET");
    writeFileSync(join(papers, "a.pdf"), Buffer.concat([
      Buffer.from("%PDF-1.4\n1 0 obj\n<< /Length " + stream.length + " >>\nstream\n"),
      stream,
      Buffer.from("\nendstream\nendobj\n"),
    ]));
    const style = resolve("src-tauri/resources/skills/quarto-render/scripts/citation_style.py");
    let result = run(style, ["--root", root, "--require-choice"]);
    assert.equal(result.status, 2, result.stderr);
    const report = readFileSync(join(manuscript, "citation-style.md"), "utf8");
    assert.match(report, /编号：1/);
    assert.match(report, /^选定：\s*$/m);
    writeFileSync(join(manuscript, "citation-style.md"), report.replace("选定：", "选定：编号"));
    result = run(style, ["--root", root, "--apply"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(join(manuscript, "citation.csl"), "utf8"), /citation-number/);
    assert.match(readFileSync(join(manuscript, "citation-style.md"), "utf8"), /选定：编号/);

    const md = join(manuscript, "review-final.md");
    const bib = join(root, "references.bib");
    writeFileSync(bib, "@article{Doe2020,\n title={Evidence}, author={Doe, Jane}, year={2020}, journal={Research}, doi={10.1/ex}\n}\n@article{Lee2021,\n title={More}, author={Lee, Ann}, year={2021}, journal={Research}, doi={10.2/ex}\n}\n");
    const onlyDoe = join(root, "only-doe.md");
    writeFileSync(onlyDoe, "See [@Doe2020].\n");
    writeFileSync(md, "See [@Doe2020] and [@Lee2021].\n");
    const output = join(root, "output");
    mkdirSync(output);
    result = run(citeDocx, ["--input", onlyDoe, "--bib", bib, "--output", join(output, "endnote.docx"), "--report", join(root, "cite.md")]);
    assert.equal(result.status, 0, result.stderr);
    const sync = resolve("src-tauri/resources/skills/endnote-bridge/scripts/sync_docx.py");
    result = run(sync, ["--root", root, "--markdown", "manuscript/review-final.md"]);
    assert.equal(result.status, 0, result.stderr);
    const diffPath = join(papers, "endnote-sync-report.md");
    const diff = readFileSync(diffPath, "utf8");
    assert.match(diff, /Lee2021 \| 删除 \| 决定：待定/);
    writeFileSync(diffPath, diff.replace("决定：待定", "决定：拒绝"));
    result = run(sync, ["--root", root, "--markdown", "manuscript/review-final.md", "--apply"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(md, "utf8"), /Lee2021/);
    writeFileSync(diffPath, readFileSync(diffPath, "utf8").replace("决定：拒绝", "决定：接受"));
    result = run(sync, ["--root", root, "--markdown", "manuscript/review-final.md", "--apply"]);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(readFileSync(md, "utf8"), /Lee2021/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Zotero 交稿写出可扫描的引用和对应 RIS，缺键不交稿", () => {
  const root = mkdtempSync(join(tmpdir(), "mesa-zotero-rtf-"));
  try {
    const md = join(root, "review-final.md");
    const bib = join(root, "references.bib");
    writeFileSync(md, "See [@Doe2020].\n");
    writeFileSync(bib, "@article{Doe2020,\n title={Evidence}, author={Doe, Jane}, year={2020}, journal={Research}, doi={10.1/ex}\n}\n");
    const script = resolve("src-tauri/resources/skills/zotero-sync/scripts/zotero_rtf.py");
    const rtf = join(root, "zotero.rtf");
    const ris = join(root, "zotero.ris");
    let result = run(script, ["--input", md, "--bib", bib, "--rtf", rtf, "--ris", ris, "--report", join(root, "report.md")]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(rtf, "utf8"), /\\\{Doe, 2020\\\}/);
    assert.match(readFileSync(ris, "utf8"), /ID  - Doe2020/);
    writeFileSync(md, "See [@Missing].\n");
    const bad = join(root, "bad.rtf");
    result = run(script, ["--input", md, "--bib", bib, "--rtf", bad, "--ris", join(root, "bad.ris"), "--report", join(root, "bad.md")]);
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(bad), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Blender validates provenance and dimensions without executing Blender; Origin probe starts no GUI", () => {
  const root = mkdtempSync(join(tmpdir(),"mesa-tool-probe-"));
  try {
    const file = join(root,"scene.json");
    const data = {kind:"schematic",units:"METRIC",provenance:"synthetic test fixture",limitations:"not experimental evidence",objects:[{shape:"cube",location:[0,0,0],scale:[1,2,3]}]};
    writeFileSync(file,JSON.stringify(data));
    const script = resolve("src-tauri/resources/skills/blender-research/scripts/build_scene.py");
    let result = run(script,["--params",file,"--validate"]);assert.equal(result.status,0,result.stderr);
    data.objects[0].scale[0]=-1;writeFileSync(file,JSON.stringify(data));
    result = run(script,["--params",file,"--validate"]);assert.notEqual(result.status,0);
    result=run(resolve("src-tauri/resources/skills/origin-plot/scripts/plot_origin.py"),["--probe"]);
    assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).readyToExecute,false);
  } finally { rmSync(root,{recursive:true,force:true}); }
});
