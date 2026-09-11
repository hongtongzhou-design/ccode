#!/usr/bin/env python3
"""Build an explicitly specified schematic in a NEW Blender background process."""
import argparse
import hashlib
import json
import math
import shutil
import subprocess
import sys
from pathlib import Path


def validate(data):
    if data.get('kind')!='schematic':raise ValueError('Only explicitly labeled schematic scenes supported')
    if data.get('units') not in ('METRIC','IMPERIAL','NONE'):raise ValueError('Declare units (or NONE for not-to-scale)')
    if not data.get('provenance') or not data.get('limitations'):raise ValueError('Source/provenance and limitations are required')
    objects=data.get('objects')
    if not isinstance(objects,list) or not 1<=len(objects)<=200:raise ValueError('Expected 1..200 explicit objects')
    for obj in objects:
        if obj.get('shape') not in ('cube','sphere','cylinder'):raise ValueError('Unsupported primitive; provide a reviewed project-specific builder')
        for key in ('location','scale'):
            values=obj.get(key)
            if not isinstance(values,list) or len(values)!=3 or any(not isinstance(v,(float,int)) or not math.isfinite(v) for v in values):raise ValueError(f'Invalid {key}')
        if any(v<=0 for v in obj['scale']):raise ValueError('Scale must be positive')
    return data


def inside(params,output):
    import bpy
    data=validate(json.loads(params.read_text(encoding='utf-8')))
    bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)
    scene=bpy.context.scene;scene.unit_settings.system=data['units']
    for item in data['objects']:
        shape=item['shape']
        if shape=='cube':bpy.ops.mesh.primitive_cube_add(size=1)
        elif shape=='sphere':bpy.ops.mesh.primitive_uv_sphere_add(radius=.5)
        else:bpy.ops.mesh.primitive_cylinder_add(radius=.5,depth=1)
        obj=bpy.context.object;obj.name=item.get('name',shape);obj.location=item['location'];obj.scale=item['scale']
    bpy.ops.object.camera_add(location=(6,-8,6));camera=bpy.context.object
    from mathutils import Vector
    camera.rotation_euler=(Vector((0,0,0))-camera.location).to_track_quat('-Z','Y').to_euler();scene.camera=camera
    bpy.ops.object.light_add(type='AREA',location=(3,-4,7));bpy.context.object.data.energy=1200;bpy.context.object.data.shape='DISK';bpy.context.object.data.size=5
    scene.render.engine='CYCLES';scene.cycles.samples=16;scene.cycles.seed=0
    scene.render.resolution_x=800;scene.render.resolution_y=600;scene.render.resolution_percentage=100
    scene.render.image_settings.file_format='PNG';scene.render.filepath=str(output/'schematic.png')
    scene['mesa_kind']='schematic';scene['mesa_provenance']=str(data['provenance']);scene['mesa_limitations']=str(data['limitations'])
    bpy.ops.wm.save_as_mainfile(filepath=str(output/'scene.blend'))
    bpy.ops.render.render(write_still=True)
    manifest={'status':'generated-awaiting-review','blenderVersion':bpy.app.version_string,'kind':'schematic','units':data['units'],'provenance':data['provenance'],'limitations':data['limitations'],'parametersHash':hashlib.sha256(params.read_bytes()).hexdigest(),'outputs':[]}
    for name in ('scene.blend','schematic.png'):
        path=output/name
        if not path.is_file() or not path.stat().st_size:raise ValueError('Missing '+name)
        manifest['outputs'].append({'path':name,'sha256':hashlib.sha256(path.read_bytes()).hexdigest()})
    (output/'blender-manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8')


def main():
    args=sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else sys.argv[1:]
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--params',type=Path,required=True);p.add_argument('--output',type=Path)
    p.add_argument('--blender');p.add_argument('--validate',action='store_true');p.add_argument('--inside-blender',action='store_true')
    a=p.parse_args(args)
    try:
        validate(json.loads(a.params.read_text(encoding='utf-8')))
        if a.validate:print('Validated schematic parameters; no Blender execution');return 0
        if not a.output:p.error('--output required for rendering')
        if a.inside_blender:inside(a.params.resolve(),a.output.resolve());return 0
        binary=a.blender or shutil.which('blender')
        if not binary:raise ValueError('Provide --blender absolute executable path')
        if a.output.exists():raise ValueError('Output exists; refusing overwrite')
        a.output.mkdir(parents=True)
        command=[binary,'--background','--factory-startup','--offline-mode','--python-exit-code','1','--python',str(Path(__file__).resolve()),'--','--inside-blender','--params',str(a.params.resolve()),'--output',str(a.output.resolve())]
        with (a.output/'render.log').open('w',encoding='utf-8') as log:
            run=subprocess.run(command,stdout=log,stderr=subprocess.STDOUT,timeout=300)
        if run.returncode:raise ValueError('Blender failed; inspect render.log')
        if not (a.output/'blender-manifest.json').is_file():raise ValueError('Missing render manifest')
        return 0
    except (OSError,ValueError,subprocess.TimeoutExpired) as e:
        print(str(e),file=sys.stderr);return 1

if __name__=='__main__':sys.exit(main())
