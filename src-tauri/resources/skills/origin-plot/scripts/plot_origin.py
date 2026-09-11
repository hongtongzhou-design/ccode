#!/usr/bin/env python3
"""Explicit Windows Origin driver; no installation, fallback, or source mutation."""
import argparse
import csv
import hashlib
import importlib.util
import json
import platform
import sys
from pathlib import Path


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--probe',action='store_true');p.add_argument('--execute',action='store_true')
    p.add_argument('--input',type=Path);p.add_argument('--output',type=Path)
    p.add_argument('--x',type=int,default=0);p.add_argument('--y',type=int,default=1)
    a=p.parse_args()
    ready=platform.system()=='Windows' and importlib.util.find_spec('originpro') is not None
    if a.probe:
        print(json.dumps({'platform':platform.system(),'originproImportable':ready,'licenseAndVersion':'not-verified','readyToExecute':False}));return 0
    if not a.execute or not a.input or not a.output: p.error('--execute, --input and --output are required')
    if not ready: print('Requires Windows + Origin 2021+ + originpro. No fallback executed.',file=sys.stderr);return 1
    created=False
    try:
        data=a.input.read_bytes()
        with a.input.open(encoding='utf-8-sig',newline='') as f: rows=list(csv.reader(f))
        if len(rows)<2 or min(a.x,a.y)<0 or any(max(a.x,a.y)>=len(r) for r in rows):raise ValueError('Invalid CSV or column selection')
        if a.output.exists():raise ValueError('Output exists; choose independent new directory')
        a.output.mkdir(parents=True);created=True
        import originpro as op
        try:
            op.set_show(False)
            version=op.lt_float('@V')
            if version<9.8:raise ValueError('Origin 2021 or newer required')
            w=op.new_sheet('w');w.from_file(str(a.input.resolve()))
            graph=op.new_graph(template='scatter');graph[0].add_plot(w,coly=a.y,colx=a.x);graph[0].rescale()
            graph.save_fig(str((a.output/'plot.png').resolve()),width=1800)
            op.save(str((a.output/'project.opju').resolve()))
            (a.output/'input.csv').write_bytes(data)
            outputs=[]
            for path in (a.output/'plot.png',a.output/'project.opju',a.output/'input.csv'):
                if not path.is_file() or not path.stat().st_size:raise ValueError(f'Missing output {path.name}')
                outputs.append({'path':path.name,'sha256':hashlib.sha256(path.read_bytes()).hexdigest()})
            manifest={'status':'generated-awaiting-review','inputHash':hashlib.sha256(data).hexdigest(),'originVersion':version,'columns':{'x':a.x,'y':a.y},'command':sys.argv,'outputs':outputs,'unverified':['Visual and numeric review','Reopen project in licensed Origin']}
            (a.output/'origin-manifest.json').write_text(json.dumps(manifest,indent=2),encoding='utf-8')
            return 0
        finally:op.exit()
    except Exception as e:
        print(str(e),file=sys.stderr)
        if created and a.output.is_dir():(a.output/'failure.txt').write_text(str(e),encoding='utf-8')
        return 1

if __name__=='__main__':sys.exit(main())
