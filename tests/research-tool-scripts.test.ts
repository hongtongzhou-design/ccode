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
// Windows 控制台默认 cp1252，docx 里的中文标题直接 print 会把整个断言打空。
const zipXml = (docx: string, names = ["word/document.xml"]) =>
  spawnSync(
    python,
    ["-c", "import sys; sys.stdout.reconfigure(encoding='utf-8'); import zipfile; z=zipfile.ZipFile(sys.argv[1]);\n[print(z.read(n).decode()) for n in sys.argv[2].split(',')]", docx, names.join(",")],
    { encoding: "utf8", timeout: 10_000 },
  );

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
    const risText = readFileSync(ris, "utf8");
    assert.match(risText, /T2  - Research/);
    assert.doesNotMatch(risText, /JO  - /);
    assert.match(risText, /VL  - 12/);
    assert.match(risText, /IS  - 3/);
    assert.match(risText, /SP  - 1\r\nM2  - 1\r\nEP  - 8/);
    assert.match(risText, /SN  - 123/);
    assert.match(risText, /AU  - Doe, Jane\r?\nAU  - Hong, Tongzhou/);
    const before = readFileSync(xml,"utf8");
    result = run(bridge, ["--input", input, "--output", xml, "--report", join(root, "overwrite.json")]);
    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(xml,"utf8"), before);
  } finally { rmSync(root,{recursive:true,force:true}); }
});

test("导入标题里的 HTML 上下标收成两个库都认的记号", () => {
  const root = mkdtempSync(join(tmpdir(), "mesa-title-mark-"));
  try {
    const input = join(root, "source.bib");
    writeFileSync(input, "@article{Gao2017,\n title={Reversible S<sup>0</sup>/MgS<sub>x</sub> Chemistry},\n author={Gao, Tao}, year={2017}, journal={Angewandte Chemie}, doi={10.1002/anie.201708241}\n}\n");
    const ris = join(root, "export.ris");
    const result = run(bridge, ["--input", input, "--output", ris, "--report", join(root, "report.json")]);
    assert.equal(result.status, 0, result.stderr);
    const text = readFileSync(ris, "utf8");
    assert.match(text, /TI  - Reversible S⁰\/MgSₓ Chemistry/);
    assert.doesNotMatch(text, /<sup>|<sub>/);
    writeFileSync(input, "@article{Yang2019,\n title={Ca2+ Mg(CF 3 SO 3 ) 2 - MgCl 2},\n author={Yang, Ann}, year={2019}, journal={Research}, doi={10.1/space}\n}\n");
    const spaced = join(root, "spaced.ris");
    const again = run(bridge, ["--input", input, "--output", spaced, "--report", join(root, "space.json")]);
    assert.equal(again.status, 0, again.stderr);
    assert.match(readFileSync(spaced, "utf8"), /Ca²⁺ Mg\(CF₃SO₃\)₂ - MgCl₂/);
    writeFileSync(input, "@article{Lee2021,\n title={A {Mg} battery},\n author={Lee, Ann and Smith, Jr., John},\n year={2021}, journal={Angew. Chem.},\n doi={https://doi.org/10.1002/example}, pages={1--8}\n}\n");
    const braced = join(root, "braced.ris");
    const third = run(bridge, ["--input", input, "--output", braced, "--report", join(root, "brace.json")]);
    assert.equal(third.status, 0, third.stderr);
    const bracedText = readFileSync(braced, "utf8");
    assert.match(bracedText, /TI  - A Mg battery/);
    assert.match(bracedText, /AU  - Smith, Jr\., John/);
    assert.match(bracedText, /DO  - 10\.1002\/example/);
    assert.doesNotMatch(bracedText, /doi\.org/);
  } finally { rmSync(root, { recursive: true, force: true }); }
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
    const zip = zipXml(docx);
    assert.equal(zip.status, 0, zip.stderr);
    assert.match(zip.stdout, /ADDIN EN\.CITE/);
    assert.match(zip.stdout, /ADDIN EN\.REFLIST/);
    assert.doesNotMatch(zip.stdout, /\{Doe, 2020/);
    writeFileSync(md, "# Title\n\n3834 mAh cm^−3^ and **bold** H~2~O.\n");
    const marked = join(root, "marked.docx");
    result = run(citeDocx, ["--input", md, "--bib", bib, "--output", marked, "--report", join(root, "mark.md")]);
    assert.equal(result.status, 0, result.stderr);
    const markZip = zipXml(marked, ["word/document.xml", "word/styles.xml"]);
    assert.match(markZip.stdout, /Heading1/);
    assert.match(markZip.stdout, /w:val="both"/);
    assert.match(markZip.stdout, /firstLineChars="200"/);
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
    writeFileSync(join(root, "dot.png"), png);
    writeFileSync(md, "---\ntitle: \"A Title\"\nabstract: |\n  One line.\nkeywords:\n  - alpha\n---\n\n## Introduction\n\n### Detail\n\n![A panel.](dot.png){#fig-1}\n");
    const fronted = join(root, "front.docx");
    result = run(citeDocx, ["--input", md, "--bib", bib, "--output", fronted, "--report", join(root, "front.md")]);
    assert.equal(result.status, 0, result.stderr);
    const frontZip = zipXml(fronted);
    assert.match(frontZip.stdout, /A Title/);
    assert.match(frontZip.stdout, /Abstract/);
    assert.match(frontZip.stdout, /Keywords/);
    assert.doesNotMatch(frontZip.stdout, /摘要|关键词|图 1/);
    assert.match(frontZip.stdout, />1 Introduction</);
    assert.match(frontZip.stdout, />1\.1 Detail</);
    assert.match(frontZip.stdout, /Figure 1/);
    writeFileSync(md, "See Figure @fig-1 and Table @tbl-1.\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n: The caption. {#tbl-1}\n\n![Panel.](dot.png){#fig-1}\n");
    const linked = join(root, "linked.docx");
    result = run(citeDocx, ["--input", md, "--bib", bib, "--output", linked, "--report", join(root, "link.md")]);
    assert.equal(result.status, 0, result.stderr);
    const linkZip = zipXml(linked);
    assert.match(linkZip.stdout, /Figure 1/);
    assert.match(linkZip.stdout, /Table 1/);
    assert.doesNotMatch(linkZip.stdout, /@fig-1|@tbl-1/);
    assert.match(markZip.stdout, /outlineLvl w:val="0"/);
    assert.match(markZip.stdout, /outlineLvl w:val="5"/);
    assert.match(markZip.stdout, /w:val="superscript"/);
    assert.match(markZip.stdout, />−3</);
    assert.doesNotMatch(markZip.stdout, /\^−3\^/);
    assert.match(markZip.stdout, /w:val="subscript"/);
    writeFileSync(md, "| A | B |\n| --- | --- |\n| 1 | [@Doe2020] |\n\n---\n");
    const tabled = join(root, "table.docx");
    result = run(citeDocx, ["--input", md, "--bib", bib, "--output", tabled, "--report", join(root, "table.md")]);
    assert.equal(result.status, 0, result.stderr);
    const tableZip = zipXml(tabled);
    assert.match(tableZip.stdout, /<w:tbl>/);
    assert.match(tableZip.stdout, /w:val="nil"/);
    assert.doesNotMatch(tableZip.stdout, /insideV w:val="single"/);
    assert.match(tableZip.stdout, /ADDIN EN\.CITE/);
    assert.match(tableZip.stdout, /w:footerReference/);
    assert.match(tableZip.stdout, /pgMar/);
    writeFileSync(
      md,
      "See {#Doe2020} and the table {#tbl-benchmark}.\n",
    );
    const braced = join(root, "braced.docx");
    result = run(citeDocx, ["--input", md, "--bib", bib, "--output", braced, "--report", join(root, "brace.md")]);
    assert.equal(result.status, 0, result.stderr);
    const braceZip = zipXml(braced);
    assert.match(braceZip.stdout, /ADDIN EN\.CITE/);
    assert.match(braceZip.stdout, /tbl-benchmark/);
    assert.doesNotMatch(braceZip.stdout, /\{#/);
    assert.match(zip.stdout, /Doe et al\., 2020/);
    assert.doesNotMatch(zip.stdout, /<Author>Missing<\/Author>/);
    assert.match(readFileSync(report, "utf8"), /未匹配：0/);

    const manuscript = join(root, "manuscript");
    const figures = join(root, "figures");
    mkdirSync(manuscript);
    mkdirSync(figures);
    const figMd = join(manuscript, "review-final.md");
    writeFileSync(
      join(figures, "fig1.png"),
      Buffer.from(
        "89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c4944415408d763f8cfff1f0005fe02fea27c9a2c0000000049454e44ae426082",
        "hex",
      ),
    );
    writeFileSync(
      figMd,
      "Before [@Doe2020].\n\n![Panel of [@Lee2021].](../figures/fig1.png){#fig-1}\n\nAfter.\n",
    );
    const withFig = join(root, "with-fig.docx");
    result = run(citeDocx, ["--input", figMd, "--bib", bib, "--output", withFig, "--report", join(root, "fig.md")]);
    assert.equal(result.status, 0, result.stderr);
    const figZip = spawnSync(
      python,
      ["-c", "import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); print('\\n'.join(z.namelist())); print(z.read('word/document.xml').decode())", withFig],
      { encoding: "utf8", timeout: 10_000 },
    );
    assert.equal(figZip.status, 0, figZip.stderr);
    assert.match(figZip.stdout, /word\/media\/image1\.png/);
    assert.match(figZip.stdout, /r:embed="rIdImg1"/);
    assert.match(figZip.stdout, /Panel of /);
    assert.match(figZip.stdout, /ADDIN EN\.CITE/);
    assert.match(readFileSync(join(root, "fig.md"), "utf8"), /插图：1/);
    writeFileSync(figMd, "![Gone.](../figures/missing.png)\n");
    const missingFig = join(root, "missing-fig.docx");
    result = run(citeDocx, ["--input", figMd, "--bib", bib, "--output", missingFig, "--report", join(root, "missing-fig.md")]);
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(missingFig), false);

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

test("域稿按 DOI 绑定本机库：唯一才写入记录号或条目地址，重复不猜", () => {
  const root = mkdtempSync(join(tmpdir(), "mesa-library-bind-"));
  try {
    const enl = join(root, "library.enl");
    const zotero = join(root, "zotero.sqlite");
    const seed = `
import sqlite3, sys
enl, zot = sys.argv[1], sys.argv[2]
e = sqlite3.connect(enl)
e.execute("CREATE TABLE misc(code INTEGER, subcode INTEGER, value BLOB, PRIMARY KEY(code, subcode))")
e.execute("INSERT INTO misc VALUES (14, 0, ?)", (b"abc123libraryid",))
e.execute("CREATE TABLE refs(id INTEGER PRIMARY KEY, trash_state INTEGER NOT NULL DEFAULT 0, electronic_resource_number TEXT NOT NULL DEFAULT '')")
e.execute("INSERT INTO refs VALUES (392, 0, '10.1000/only')")
e.execute("INSERT INTO refs VALUES (10, 0, '10.1000/dup')")
e.execute("INSERT INTO refs VALUES (11, 0, '10.1000/dup')")
e.execute("INSERT INTO refs VALUES (12, 1, '10.1000/trashed')")
e.commit()
z = sqlite3.connect(zot)
z.execute("CREATE TABLE settings(setting TEXT, key TEXT, value TEXT)")
z.execute("INSERT INTO settings VALUES ('account', 'localUserKey', 'UserKey1')")
z.execute("CREATE TABLE libraries(libraryID INTEGER PRIMARY KEY, type TEXT)")
z.execute("INSERT INTO libraries VALUES (1, 'user')")
z.execute("CREATE TABLE items(itemID INTEGER PRIMARY KEY, libraryID INTEGER, key TEXT)")
z.execute("CREATE TABLE fields(fieldID INTEGER PRIMARY KEY, fieldName TEXT)")
z.execute("CREATE TABLE itemDataValues(valueID INTEGER PRIMARY KEY, value TEXT)")
z.execute("CREATE TABLE itemData(itemID INTEGER, fieldID INTEGER, valueID INTEGER)")
z.execute("CREATE TABLE deletedItems(itemID INTEGER)")
z.execute("INSERT INTO fields VALUES (1, 'DOI')")
z.execute("INSERT INTO items VALUES (1, 1, 'ONLYKEY8')")
z.execute("INSERT INTO items VALUES (2, 1, 'DUPKEY0A')")
z.execute("INSERT INTO items VALUES (3, 1, 'DUPKEY0B')")
z.execute("INSERT INTO itemDataValues VALUES (1, '10.1000/only')")
z.execute("INSERT INTO itemDataValues VALUES (2, 'https://doi.org/10.1000/dup')")
z.execute("INSERT INTO itemData VALUES (1, 1, 1)")
z.execute("INSERT INTO itemData VALUES (2, 1, 2)")
z.execute("INSERT INTO itemData VALUES (3, 1, 2)")
z.commit()
`;
    const seeded = spawnSync(python, ["-c", seed, enl, zotero], { encoding: "utf8" });
    assert.equal(seeded.status, 0, seeded.stderr);
    const md = join(root, "review-final.md");
    const bib = join(root, "references.bib");
    writeFileSync(md, "See [@Only2020] and [@Dup2021] and [@None2022].\n");
    writeFileSync(bib, [
      "@article{Only2020, title={Only}, author={Doe, Jane}, year={2020}, doi={10.1000/only}}",
      "@article{Dup2021, title={Dup}, author={Roe, Ann}, year={2021}, doi={DOI: 10.1000/dup.}}",
      "@article{None2022, title={None}, author={Lee, Bo}, year={2022}, doi={10.9999/missing}}",
      "",
    ].join("\n"));
    const endnote = join(root, "endnote.docx");
    let result = run(citeDocx, ["--input", md, "--bib", bib, "--output", endnote, "--report", join(root, "en.md"), "--endnote-library", enl]);
    assert.equal(result.status, 0, result.stderr);
    const enXml = zipXml(endnote);
    assert.match(enXml.stdout, /abc123libraryid/);
    assert.match(enXml.stdout, /&lt;RecNum&gt;392&lt;\/RecNum&gt;/);
    assert.doesNotMatch(enXml.stdout, /&lt;RecNum&gt;10&lt;\/RecNum&gt;/);
    const enReport = readFileSync(join(root, "en.md"), "utf8");
    assert.match(enReport, /已绑定 1 条/);
    assert.match(enReport, /Dup2021.*2 条/);
    assert.match(enReport, /None2022.*没有/);
    const pointer = join(root, "papers");
    mkdirSync(pointer);
    writeFileSync(join(pointer, "endnote-library.path"), `${enl}\n`);
    const viaPointer = join(root, "via-pointer.docx");
    result = run(citeDocx, ["--input", md, "--bib", bib, "--output", viaPointer, "--report", join(root, "pointer.md"), "--project-root", root]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(join(root, "pointer.md"), "utf8"), /已绑定 1 条/);
    const unbound = join(root, "unbound.docx");
    result = run(citeDocx, ["--input", md, "--bib", bib, "--output", unbound, "--report", join(root, "unbound.md")]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(join(root, "unbound.md"), "utf8"), /未指定 EndNote 库/);
    const unboundXml = zipXml(unbound);
    assert.doesNotMatch(unboundXml.stdout, /abc123libraryid/);
    assert.doesNotMatch(unboundXml.stdout, /db-id="mesa"/);
    assert.doesNotMatch(unboundXml.stdout, /foreign-keys/);

    const zoteroDocx = join(root, "zotero.docx");
    const zoteroScript = resolve("src-tauri/resources/skills/zotero-sync/scripts/zotero_docx.py");
    result = run(zoteroScript, ["--input", md, "--bib", bib, "--output", zoteroDocx, "--report", join(root, "zo.md"), "--zotero-db", zotero]);
    assert.equal(result.status, 0, result.stderr);
    const zoXml = zipXml(zoteroDocx);
    assert.match(zoXml.stdout, /users\/local\/UserKey1\/items\/ONLYKEY8/);
    assert.doesNotMatch(zoXml.stdout, /DUPKEY0/);
    assert.doesNotMatch(zoXml.stdout, /ITEM-/);
    const zoReport = readFileSync(join(root, "zo.md"), "utf8");
    assert.match(zoReport, /已绑定 1 条/);
    assert.match(zoReport, /Dup2021.*2 条/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Zotero 域稿写出 ADDIN ZOTERO_ITEM，缺键不交 docx", () => {
  const root = mkdtempSync(join(tmpdir(), "mesa-zotero-docx-"));
  try {
    const md = join(root, "review-final.md");
    const bib = join(root, "references.bib");
    writeFileSync(md, "See [@Doe2020] and [@Doe2020; @Lee2021].\n");
    writeFileSync(
      bib,
      "@article{Doe2020,\n title={Evidence}, author={Doe, Jane and Roe, John}, year={2020}, journal={Research}, doi={10.1/ex}\n}\n@article{Lee2021,\n title={More}, author={Lee, Ann}, year={2021}, journal={Research}\n}\n",
    );
    const script = resolve("src-tauri/resources/skills/zotero-sync/scripts/zotero_docx.py");
    const docx = join(root, "zotero.docx");
    let result = run(script, ["--input", md, "--bib", bib, "--output", docx, "--report", join(root, "report.md")]);
    assert.equal(result.status, 0, result.stderr);
    const zip = zipXml(docx, ["word/document.xml", "word/styles.xml"]);
    assert.equal(zip.status, 0, zip.stderr);
    assert.match(zip.stdout, /ADDIN ZOTERO_ITEM CSL_CITATION/);
    assert.match(zip.stdout, /citationID/);
    assert.match(zip.stdout, /formattedCitation/);
    assert.match(zip.stdout, /ADDIN ZOTERO_BIBL/);
    assert.match(zip.stdout, /outlineLvl w:val="0"/);
    assert.match(zip.stdout, /w:footerReference/);
    assert.match(zip.stdout, /CSL_BIBLIOGRAPHY/);
    assert.match(zip.stdout, /Doe et al\., 2020/);
    assert.doesNotMatch(zip.stdout, /\\\{Doe, 2020/);
    writeFileSync(md, "See {#Doe2020} and {#tbl-benchmark}.\n");
    const braced = join(root, "braced.docx");
    result = run(script, ["--input", md, "--bib", bib, "--output", braced, "--report", join(root, "brace.md")]);
    assert.equal(result.status, 0, result.stderr);
    const braceZip = zipXml(braced);
    assert.match(braceZip.stdout, /ADDIN ZOTERO_ITEM CSL_CITATION/);
    assert.match(braceZip.stdout, /tbl-benchmark/);
    assert.doesNotMatch(braceZip.stdout, /\{#/);
    assert.match(readFileSync(join(root, "report.md"), "utf8"), /未匹配：0/);
    writeFileSync(md, "See [@Missing].\n");
    const bad = join(root, "bad.docx");
    result = run(script, ["--input", md, "--bib", bib, "--output", bad, "--report", join(root, "bad.md")]);
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(bad), false);
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
    const zoteroRis = readFileSync(ris, "utf8");
    assert.match(zoteroRis, /T2  - Research/);
    assert.doesNotMatch(zoteroRis, /JO  - /);
    assert.doesNotMatch(zoteroRis, /M2  - /);
    writeFileSync(md, "See [@Missing].\n");
    const bad = join(root, "bad.rtf");
    result = run(script, ["--input", md, "--bib", bib, "--rtf", bad, "--ris", join(root, "bad.ris"), "--report", join(root, "bad.md")]);
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(bad), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("ISO 4 缩写按期刊全称，带句点；一词刊名不缩", () => {
  const script = resolve("src-tauri/resources/skills/endnote-bridge/scripts/bridge.py");
  const probe = [
    "import importlib.util",
    `spec = importlib.util.spec_from_file_location("bridge", ${JSON.stringify(script)})`,
    "mod = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(mod)",
    "from pathlib import Path",
    "Path(mod.__file__).with_name('journal-abbreviations.csv').write_text(",
    "  'Energy Storage Materials,Energy Storage Mater.\\nThe Chemical Record,Chem. Rec.\\nNature,Nature\\n',",
    "  encoding='utf-8')",
    "mod._MESA_ISO4 = mod.load_mesa_iso4()",
    "mod._iso4_index = {",
    "  'advanced materials': 'Adv. Mater.',",
    "  'advanced engineering materials': 'Adv. Eng. Mater.',",
    "  'small': 'Small',",
    "}",
    "assert mod.iso4_abbreviation('Advanced Materials') == 'Adv. Mater.'",
    "assert mod.iso4_abbreviation('Advanced Engineering Materials') == 'Adv. Eng. Mater.'",
    "assert mod.iso4_abbreviation('Small') == 'Small'",
    "assert mod.iso4_abbreviation('Unknown Journal') == ''",
    "assert mod.iso4_abbreviation('Energy Storage Materials') == 'Energy Storage Mater.'",
    "assert mod.iso4_abbreviation('The Chemical Record') == 'Chem. Rec.'",
    "assert mod.iso4_abbreviation('Nature') == 'Nature'",
  ].join("\n");
  const result = spawnSync(python, ["-c", probe], { encoding: "utf8", timeout: 20_000 });
  assert.equal(result.status, 0, result.stderr);
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
