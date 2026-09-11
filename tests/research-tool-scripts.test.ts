import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const python = process.platform === "win32" ? "python" : "python3";
const bridge = resolve("src-tauri/resources/skills/endnote-bridge/scripts/bridge.py");
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
