#!/usr/bin/env python3
"""Small reproducible workflow pilots; outputs outside git, no credentials or agent dispatch.

create --output NEW_DIR --sources DIR --literature FILE
reproduce --input PROJECT_DIR --output NEW_DIR
Literature source/support annotations require actual source reading; checks do not infer entailment.
"""
# MESA_REPRODUCE: {"interpreter":"python","subcommand":"reproduce","outputPlacement":"independent","resultFile":"verification.json"}
import argparse
import hashlib
import json
import math
from pathlib import Path
import random
import shutil
import statistics
import sys

SEED = 20260908

def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def write(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n" if not isinstance(value, str) else value.rstrip() + "\n", encoding="utf-8")

def load(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))

def fresh(path):
    path = Path(path).resolve()
    path.mkdir(parents=True, exist_ok=False)
    return path

def inside(root, rel):
    path = (root / rel).resolve()
    if not path.is_relative_to(root.resolve()):
        raise ValueError("path outside project")
    return path

def summary(answer, evidence, unverified, issues, decision, status="已生成待审"):
    return f"## 验收摘要\n\n- 回答：{answer}\n- 证据入口：{evidence}\n- 未验证：{unverified}\n- 未决问题：{issues}\n- 待人决定：{decision}\n- 质量状态：{status}；执行助手自评，不是人工批准。\n"

def exact_ids(expected, actual):
    def ids(rows):
        values = [row.get("id") for row in rows]
        if not values or any(not isinstance(x, str) or not x.strip() for x in values) or len(set(values)) != len(values):
            raise ValueError("empty/duplicate/invalid IDs")
        return set(values)
    if ids(expected) != ids(actual):
        raise ValueError("plan/result ID mismatch")

def check_literature(project):
    records = load(project / "notes/index.json")
    included = load(project / "papers/included.json")
    exact_ids(included, records)
    index = {x["id"]: x for x in records}
    claims = load(project / "notes/claims.json")
    if not claims:
        raise ValueError("no claims to review")
    exact_ids(claims, claims)
    bibliography = (project / "references.bib").read_text(encoding="utf-8")
    for claim in claims:
        source = index.get(claim["sourceId"])
        if not source or claim["bibKey"] != source["bibKey"] or f"{{{claim['bibKey']}," not in bibliography:
            raise ValueError("citation key/source mismatch")
        if source["fulltextStatus"] != "fulltext":
            raise ValueError("critical full text missing")
        path = inside(project, source["sourcePath"])
        if not path.is_file() or sha(path) != source["sourceHash"]:
            raise ValueError("source version changed or missing")
        if not source["locator"] or not source["reviewer"]:
            raise ValueError("missing evidence review")
        if claim["support"] != "supported-with-scope":
            raise ValueError("claim support unresolved (review annotation, not automatic entailment)")
    return claims

def accuracy(truth, predictions):
    if len(truth) != len(predictions) or not truth:
        raise ValueError("invalid accuracy input")
    return sum(a == b for a, b in zip(truth, predictions)) / len(truth)

def score(rows, labels, feature, sign):
    return accuracy(labels, [sign * row[feature] for row in rows])

def experiment(dataset, features):
    train, selection, heldout = [dataset[name] for name in ["train", "selection", "heldout"]]
    # Learn feature direction on training only, select on selection only; heldout never selects.
    candidates = []
    for j in range(features):
        sign = 1 if score(train["x"], train["y"], j, 1) >= 0.5 else -1
        candidates.append((score(selection["x"], selection["y"], j, sign), j, sign))
    best = max(candidates, key=lambda r: (r[0], -r[1]))
    test_score = score(heldout["x"], heldout["y"], best[1], best[2])
    return {"features": features, "feature": best[1], "sign": best[2], "selectionAccuracy": best[0], "heldoutAccuracy": test_score, "optimism": best[0] - test_score}

def aggregate(rows):
    result = []
    for features in [1, 8, 32]:
        group = [x for x in rows if x.get("status") == "success" and x["metrics"]["features"] == features]
        result.append({"features": features, "n": len(group), **{name: statistics.mean(x["metrics"][name] for x in group) for name in ["selectionAccuracy", "heldoutAccuracy", "optimism"]}})
    return result

def check_computational(project):
    plan = load(project / "experiments/matrix.json")
    manifest = load(project / "results/run-manifest.json")
    records = load(project / "results/matrix.json")
    exact_ids(plan, manifest)
    exact_ids(plan, records)
    expected = load(project / "results/reference.json")
    planned = {row["id"]: row for row in plan}
    recorded = {row["id"]: row for row in records}
    for row in manifest:
        if row["status"] != recorded[row["id"]]["status"]:
            raise ValueError("manifest/result status mismatch")
        if recorded[row["id"]]["configuration"] != planned[row["id"]]["configuration"]:
            raise ValueError("plan/result configuration mismatch")
    if sha(project / "experiments/reproduce.py") != expected["codeHash"]:
        raise ValueError("reproduction code version mismatch")
    if sha(project / "experiments/matrix.json") != expected["planHash"]:
        raise ValueError("plan version mismatch")
    for entry in manifest:
        if entry["status"] == "failed":
            log = inside(project, entry["outputs"]["path"])
            if not log.is_file() or sha(log) != entry["outputs"]["sha256"]:
                raise ValueError("failed run log missing or changed")
            continue
        data = inside(project, entry["input"])
        if sha(data) != entry["dataHash"]:
            raise ValueError("data version changed")
        output = inside(project, entry["outputs"]["path"])
        if sha(output) != entry["outputs"]["sha256"]:
            raise ValueError("raw result version changed")
    actual = aggregate(records)
    if len(actual) != len(expected["metrics"]) or not math.isfinite(expected["tolerance"]) or expected["tolerance"] < 0:
        raise ValueError("invalid reference shape or tolerance")
    for got, reference in zip(actual, expected["metrics"]):
        for key, value in reference.items():
            if not math.isclose(got[key], value, rel_tol=0, abs_tol=expected["tolerance"]):
                raise ValueError(f"reference mismatch: {key}")
    return records, actual

def write_results(root, metrics):
    table = "| Features | Runs | Selection accuracy | Held-out accuracy | Optimism |\n|---:|---:|---:|---:|---:|\n"
    for r in metrics:
        table += f"| {r['features']} | {r['n']} | {r['selectionAccuracy']:.6f} | {r['heldoutAccuracy']:.6f} | {r['optimism']:.6f} |\n"
    write(root / "analysis/results-table.md", table)
    # SVG generated deterministically, labels in English; descriptive comparison, not inferential CI.
    bars = []
    for i, r in enumerate(metrics):
        x = 100 + 160*i
        for offset, key, color in [(0, "selectionAccuracy", "#3465a4"), (50, "heldoutAccuracy", "#a05a2c")]:
            height = r[key] * 220
            bars.append(f'<rect x="{x+offset}" y="{280-height:.3f}" width="40" height="{height:.3f}" fill="{color}"/><text x="{x+offset}" y="{270-height:.3f}" font-size="12">{r[key]:.3f}</text>')
        bars.append(f'<text x="{x}" y="305" font-size="13">{r["features"]} features</text>')
    svg = '<svg xmlns="http://www.w3.org/2000/svg" width="650" height="370"><rect width="650" height="370" fill="white"/><text x="30" y="30" font-size="18">Synthetic null model selection pilot</text><text x="30" y="55" font-size="13">Descriptive means; blue = selection, brown = held-out</text><line x1="60" x2="610" y1="280" y2="280" stroke="black"/><line x1="60" x2="60" y1="60" y2="280" stroke="black"/><text x="24" y="65">1.0</text><text x="24" y="284">0.0</text>' + ''.join(bars) + '<text x="30" y="348" font-size="12">12 independent synthetic datasets; no scientific generalization claim</text></svg>'
    write(root / "figures/selection.svg", svg)
    write(root / "analysis/rebuilt.json", metrics)

def reproduce(project, out):
    project = Path(project).resolve()
    destination = Path(out).resolve()
    if destination.is_relative_to(project) or project.is_relative_to(destination):
        raise ValueError("output must be separate from input project")
    # Validate completely before writing any final output.
    if (project / "notes/claims.json").is_file():
        claims = check_literature(project)
        result = "# 聚焦综合（待人工评阅）\n\n" + summary("两篇论文支持把模型选择与最终评价区分。", "notes/index.json 与原文定位", "非穷尽检索、无独立人类复核", "不得声称任意条件下严格无偏", "确认有限范围或补文献")
        result += "\n" + " ".join(c["text"] + f" [@{c['bibKey']}]" for c in claims) + "\n\n此为两篇方法论文的有限综合，不替代系统综述或对具体模型的实证评价。"
        out = fresh(out)
        write(out / "manuscript/draft.md", result)
        write(out / "verification.json", {"checks": "source hash, ID coverage, keys, explicitly reviewed support annotations", "notVerified": "automatic semantic entailment or human approval", "claims": len(claims)})
    else:
        records, metrics = check_computational(project)
        # Independent arithmetic from raw predictions, not the primary accuracy helper.
        rebuilt = []
        for entry in load(project / "results/run-manifest.json"):
            if entry["status"] != "success":
                continue
            raw = load(inside(project, entry["outputs"]["path"]))
            recomputed = {}
            for split in ["selection", "heldout"]:
                truth, predictions = raw[split+"Truth"], raw[split+"Prediction"]
                if not truth or len(truth) != len(predictions) or any(v not in (-1, 1) for v in truth + predictions):
                    raise ValueError("invalid raw prediction pairs")
                pairs = list(zip(truth, predictions))
                recomputed[split+"Accuracy"] = 1 - sum((a-b)**2 for a,b in pairs)/(4*len(pairs))
            orig = next(row for row in records if row["id"] == entry["id"])
            for key, number in recomputed.items():
                if not math.isclose(number, orig["metrics"][key], abs_tol=1e-12, rel_tol=0):
                    raise ValueError(f"independent recalculation mismatch {entry['id']} {key}")
            rebuilt.append(orig)
        out = fresh(out)
        write_results(out, metrics)
        write(out / "verification.json", {"status":"mechanical-reproduction-passed", "independentlyRecalculatedRuns":len(rebuilt), "tolerance":1e-12, "humanApproval":False})
    return out

def failures(project, out, kind):
    cases = ["missing-fulltext", "wrong-key", "unsupported-claim", "source-drift"] if kind == "literature" else ["missing-run", "data-drift", "wrong-metric", "missing-failure-log"]
    observations = []
    for name in cases:
        clone = out / "faults" / name
        shutil.copytree(project, clone)
        if kind == "literature":
            if name in ["wrong-key", "unsupported-claim"]:
                claims = load(clone / "notes/claims.json")
                if name == "wrong-key": claims[0]["bibKey"] = "varma2006bias"
                else:
                    claims[0]["text"] = "嵌套交叉验证在任何条件下严格无偏。"
                    claims[0]["support"] = "unsupported: assistant source review found claim exceeds near-unbiased scope"
                write(clone / "notes/claims.json", claims)
            else:
                ix = load(clone / "notes/index.json")
                if name == "missing-fulltext": ix[0]["fulltextStatus"] = "abstract-only"; write(clone / "notes/index.json", ix)
                else: write(clone / ix[0]["sourcePath"], "changed source version")
        else:
            if name in ["missing-run", "wrong-metric"]:
                rows = load(clone / "results/matrix.json")
                if name == "missing-run": rows.pop(0)
                else: rows[0]["metrics"]["heldoutAccuracy"] += 0.2
                write(clone / "results/matrix.json", rows)
            elif name == "data-drift": write(clone / "data/trial-00.json", "changed dataset")
            else: (clone / "artifacts/failure-control.log").unlink()
        try:
            reproduce(clone, out / "fault-outputs" / name)
        except (ValueError, OSError) as exc:
            observations.append({"case":name, "blocked":True, "reason":str(exc), "origin":"seeded fault; not an observed autonomous Agent error"})
        else:
            raise AssertionError(f"fault not detected: {name}")
    return observations

def create(out, sources, literature):
    out = fresh(out)
    script = Path(__file__).resolve()
    lit = out / "literature"
    definition = load(literature)
    source_root = Path(sources)
    if (source_root / "fetch.json").is_file():
        write(out / "source-fetch-log.json", load(source_root / "fetch.json"))
    write(lit / "project.json", {"type":"literature", "question":definition["question"], "approval":"not requested; pilot artifacts only"})
    included, index, bib = [], [], []
    for src in definition["sources"]:
        source = Path(sources)/src["sourceFile"]
        if not source.is_file() or source.stat().st_size < 1000:
            raise ValueError("fulltext extraction absent: " + str(source))
        dest = lit / "papers" / src["sourceFile"]
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, dest)
        included.append({"id":src["id"],"title":src["title"],"decision":"included","reason":"focused methods pilot"})
        index.append({"id":src["id"],"notePath":f"notes/{src['id']}.md","bibKey":src["bibKey"],"fulltextStatus":"fulltext","reviewStatus":"assistant-reviewed-human-pending","sourcePath":str(dest.relative_to(lit)),"sourceHash":sha(dest),"locator":src["locator"],"reviewer":definition["review"]})
        sections = [src["evidence"], definition["question"], src["methods"], src["evidence"]+"（"+src["locator"]+"）", src["limit"], "使用上述定位，保留可能性与条件限制，不逐字引文。", "支持本试跑的评价隔离问题。", "无独立人类复核；不声称全文领域覆盖。"]
        write(lit/f"notes/{src['id']}.md", '# '+src['title']+'\n\n'+summary(src['evidence'],src['locator'],src['limit'],'人工复核未完成','接受有限综合或补检索')+'\n'+'\n\n'.join('## '+title+'\n\n'+body for title,body in zip(['一句话总结','研究问题','方法','主要结果','局限','可引用点','与本课题关系','待跟进'],sections)))
        fields={"title":src["title"],"author":src["authors"],"journal":src["venue"],"year":str(src["year"]),"volume":src["volume"],"pages":src["pages"],"url":src["url"]}
        if src.get("doi"): fields["doi"]=src["doi"]
        bib.append('@article{'+src['bibKey']+',\n'+''.join('  '+k+' = {'+v+'},\n' for k,v in fields.items())+'}\n')
    write(lit/'papers/included.json',included)
    write(lit/'papers/included.md','\n'.join(f"{s['title']} — {s['authors']}, {s['year']} — {s['venue']} — {s['url']}" for s in definition['sources']))
    write(lit/'notes/index.json',index);write(lit/'notes/claims.json',definition['claims']);write(lit/'references.bib','\n'.join(bib))
    write(lit/'papers/to-fetch.md','# 待获取全文\n\n无；另有网络通道受限，见 screening.md。')
    write(lit/'papers/to-fetch.ris','# No pending full text in this limited pilot')
    write(lit/'papers/zotero-sync.md','未授权写入用户文献库；未执行同步。')
    write(lit/'papers/screening.md','# 检索与筛选（聚焦试跑）\n\n'+summary(definition['question'],'included.md；来源与哈希见 notes/index.json','未做系统检索','无真实人类批准','是否扩大综述')+'\n检索日期：2026-09-08\n\n'+definition['scope']+'\n\n检索记录：网页搜索请求未返回可用结果；按已知文献标题访问官方 JMLR/BMC 来源（定向检索），纳入两篇方法学论文。PMC 通道返回验证页，不当全文；BMC 出版社与 JMLR PDF 取得全文。未检索 WoS/CNKI/灰色文献；不报告虚构数据库命中量。\n\n决策摘要：A 两篇方法论文有限综合；B 系统综述需另定方案与全面检索。推荐 A，依据见原文；B 的成本/覆盖尚未评估。待人决定；当前仅写有限范围试跑草稿。')
    write(lit/'outline.md','# 综合结构\n\n'+summary('选择与评价为何分离','notes/index.json、claims.json','泛化到其他问题','系统覆盖未做','是否采纳有限稿')+'\n1. 有限样本选择准则的方差与过拟合\n2. 将选择过程包入评价、限定适用范围\n\n不强制范式卡片数量；无证据支撑任意条件严格无偏。')
    (lit/'experiments').mkdir();shutil.copyfile(script,lit/'experiments/reproduce.py')
    reproduce(lit, out/'literature-rebuilt')
    shutil.copytree(out/'literature-rebuilt/manuscript',lit/'manuscript')
    write(lit/'manuscript/citation-check.md','# 引用与支持范围\n\n'+summary('两条论断均有指定来源和限定范围','notes/claims.json；来源定位 notes/index.json','未做独立人类终审','强无偏断言已拒绝','是否认可当前范围')+'\n键、ID、哈希由脚本核验；支持性为助手实际阅读后的注释，不是脚本自动理解。')
    comp=out/'computational';write(comp/'project.json',{'type':'computational','seed':SEED,'synthetic':True})
    write(comp/'design.md','# Design v1 (pilot, not a scientific preregistration)\n\n'+summary('有限样本选择与独立评价差值','计划矩阵、合成数据','不是原文算法复现或真实应用研究','无人类批准，仅流程演示','是否把此设计用于后续真实项目')+'\nSynthetic independent random ±1 features and labels; 12 independent datasets, each train=24, selection=24, heldout=128, max features=32. Candidate counts 1/8/32. Fit signs on train; select on selection; heldout scores never select. Primary descriptive metric: selectionAccuracy-heldoutAccuracy. All cells retained, no p-values/causal claims. Fixed seed and run count, no result-driven stopping. One predeclared failure-control cell tests log retention, excluded from means by design. No personal data. Stdlib Python only.\n\n决策摘要：A 固定有限合成实验检验流程；B 完整嵌套 CV 需不同实现与预算。采用 A 作为助手试跑选择，不记为用户批准；不扩展为新科研结论。')
    rng=random.Random(SEED);plan=[];records=[];manifest=[]
    for trial in range(12):
        dataset={}
        for split,n in [('train',24),('selection',24),('heldout',128)]:
            dataset[split]={'x':[[rng.choice([-1,1]) for _ in range(32)] for _ in range(n)],'y':[rng.choice([-1,1]) for _ in range(n)]}
        path=comp/f'data/trial-{trial:02}.json';write(path,dataset)
        for count in [1,8,32]:
            key=f'trial-{trial:02}-features-{count}';config={'trial':trial,'features':count}
            plan.append({'id':key,'configuration':config,'status':'planned'})
            metrics=experiment(dataset,count);j,sign=metrics['feature'],metrics['sign']
            raw={split+suffix: (dataset[split]['y'] if suffix=='Truth' else [sign*row[j] for row in dataset[split]['x']]) for split in ['selection','heldout'] for suffix in ['Truth','Prediction']}
            output=comp/f'artifacts/{key}.json';write(output,raw)
            records.append({'id':key,'configuration':config,'status':'success','metrics':metrics})
            manifest.append({'id':key,'input':str(path.relative_to(comp)),'dataHash':sha(path),'codeVersion':sha(script),'environment':{'python':sys.version.split()[0],'dependencies':'stdlib'},'command':f'create seed={SEED} trial={trial} features={count}','status':'success','outputs':{'path':str(output.relative_to(comp)),'sha256':sha(output)}})
    key='failure-control';plan.append({'id':key,'configuration':{'purpose':'deliberate failure-control'},'status':'planned'})
    try: accuracy([],[])
    except ValueError as error: write(comp/'artifacts/failure-control.log',str(error))
    records.append({'id':key,'configuration':{'purpose':'deliberate failure-control'},'status':'failed','reason':'expected invalid input control, excluded by design'})
    manifest.append({'id':key,'status':'failed','dataHash':'not-applicable: invalid-input control','codeVersion':sha(script),'environment':'stdlib','command':'accuracy([], [])','outputs':{'path':'artifacts/failure-control.log','sha256':sha(comp/'artifacts/failure-control.log')}})
    write(comp/'experiments/matrix.json',plan);write(comp/'results/matrix.json',records);write(comp/'results/run-manifest.json',manifest)
    shutil.copyfile(script,comp/'experiments/reproduce.py')
    metrics=aggregate(records)
    # Data archive/EDA profile before interpretation: every generated field, no missing values.
    profile = []
    for path in sorted((comp/'data').glob('trial-*.json')):
        dataset = load(path)
        for split, data in dataset.items():
            profile.append({'dataset': path.name, 'split': split, 'rows': len(data['y']), 'features': len(data['x'][0]), 'missing': 0, 'positiveLabels': data['y'].count(1), 'positiveFeatures': [sum(row[j] == 1 for row in data['x']) for j in range(32)]})
    write(comp/'analysis/data-profile.json', profile)
    write(comp/'data-dictionary.md', '# Synthetic data profile\n\nAll features and labels are independent simulated ±1 variables, not measurements of people. Each trial is independent; candidate counts within trial are paired. 12 datasets; train 24, selection 24, heldout 128 per dataset. 32 features, no missing values or silent cleaning. Every feature sign count is in analysis/data-profile.json. Full cross-feature correlation is not needed to answer the selection/evaluation question. Warning: fixed finite Monte Carlo sample, descriptive output only, no unreported search over seeds.\n')
    write(comp/'results/reference.json',{'metrics':metrics,'tolerance':1e-12,'codeHash':sha(script),'planHash':sha(comp/'experiments/matrix.json')})
    write(comp/'results/summary.md','# Execution\n\n'+summary('36成功、1预设故障控制保留日志','matrix.json、run-manifest.json','真实数据/独立用户执行','不含未执行实验','审阅设计后决定是否继续')+'\n配置：每个计划 id 均有记录。数据、原始预测不手改。')
    reproduce(comp,out/'computational-rebuilt')
    shutil.copytree(out/'computational-rebuilt/analysis',comp/'analysis',dirs_exist_ok=True);shutil.copytree(out/'computational-rebuilt/figures',comp/'figures')
    cmd='python3 experiments/reproduce.py reproduce --input . --output ../recheck-new'
    write(comp/'results/implementation-check.md','# Implementation & reproduction\n\n'+summary('已从原始预测独立算术复算36项','../computational-rebuilt/verification.json','非独立实验室/真人复现','数值正确不证明外部效度','审阅后决定是否用于教学')+f'\n命令：`{cmd}`\n\nPython 3.10+，标准库，无需安装；指定不存在的输出目录，绝不覆盖输入或旧结果。固定参考容差 1e-12；比较匹配率与±1编码平方误差两种实现。验证不重跑昂贵实验。')
    write(comp/'analysis/stats-check-results.md','# Statistics check\n\n'+summary('描述性差值，未作假设检验','results-table.md；独立算术复核','外部效度与 Monte Carlo 精度','不能当真实模型性能','仅作为流程演示')+'\n分析单元为独立合成数据集，候选数之间配对但无 p 值比较。失败控制预先声明，不从成功结果中挑选。无多重显著性推断；不报告伪造 CI。')
    write(comp/'analysis/findings.md','# Findings\n\n'+summary('样本选择准则与留出评价的描述性差异','results-table.md、selection.svg','新数据/真实任务','仅合成固定种子结果','接受有限演示或设计新实验')+'\n探索性模式：见表中实际数值；不根据输出改变样本数、指标或选题，不把正差预写成验收条件。')
    write(comp/'manuscript/draft.md','# Synthetic pilot result (not for submission)\n\n'+summary('仅报告运行得到的描述性结果','../analysis/results-table.md','真实数据、外部验证、投稿审查','无人类终审','是否将流程用于真实项目')+'\nWe evaluated a fixed sign-feature selector on independent synthetic null datasets. Direction fitting, candidate selection and held-out evaluation used disjoint samples. All planned cells are retained, including a predeclared failure-control. The table reports descriptive mean accuracies; these results neither reproduce the source papers\' algorithms nor establish general performance guarantees.\n')
    observations=failures(lit,out/'literature-checks','literature')+failures(comp,out/'computational-checks','computational')
    write(out/'pilot-results.json',{'seed':SEED,'literatureClaims':2,'computationalRuns':36,'retainedFailureControls':1,'faults':observations,'humanApproval':False,'limitations':['faults are seeded, not autonomous Agent behavior','support labels are source-reviewed annotations','no novice user study','synthetic computational result only']})
    return out

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    sub=parser.add_subparsers(dest='command',required=True)
    c=sub.add_parser('create');c.add_argument('--output',required=True);c.add_argument('--sources',required=True);c.add_argument('--literature',required=True)
    r=sub.add_parser('reproduce');r.add_argument('--input',required=True);r.add_argument('--output',required=True)
    a=parser.parse_args()
    try:
        result=create(a.output,a.sources,a.literature) if a.command=='create' else reproduce(a.input,a.output)
        print(result)
    except (ValueError,OSError,KeyError,TypeError,ZeroDivisionError) as exc:
        print('BLOCKED: '+str(exc),file=sys.stderr);sys.exit(2)
