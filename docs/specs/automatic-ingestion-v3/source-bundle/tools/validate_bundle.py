#!/usr/bin/env python3
from __future__ import annotations
from pathlib import Path
import hashlib, json, re, sys, yaml
from collections import defaultdict, deque
from jsonschema import Draft202012Validator, FormatChecker

ROOT=Path(__file__).resolve().parents[1]
errors=[]; notes=[]

def err(msg): errors.append(msg)
def load(path):
    try:
        if path.suffix=='.json': return json.loads(path.read_text())
        return yaml.safe_load(path.read_text())
    except Exception as e:
        err(f'parse {path.relative_to(ROOT)}: {e}'); return None

def sha(path): return hashlib.sha256(path.read_bytes()).hexdigest()

# Parse all JSON/YAML.
for p in sorted(ROOT.rglob('*')):
    if p.is_file() and p.suffix in {'.json','.yaml','.yml'}:
        load(p)

# Schemas and validators.
schemas={}
for p in sorted((ROOT/'schemas').glob('*.json')):
    d=load(p)
    if d is None: continue
    try: Draft202012Validator.check_schema(d)
    except Exception as e: err(f'invalid schema {p.name}: {e}')
    schemas[p.name]=d

def validate_obj(obj,schema_name,label):
    if schema_name not in schemas:
        err(f'{label}: missing schema {schema_name}'); return
    v=Draft202012Validator(schemas[schema_name],format_checker=FormatChecker())
    for e in sorted(v.iter_errors(obj),key=lambda x:list(x.path)):
        err(f"{label}: {'/'.join(map(str,e.path)) or '<root>'}: {e.message}")

# Agents.
agents={}
for p in sorted((ROOT/'agents').glob('*.yaml')):
    d=load(p)
    if not d: continue
    validate_obj(d,'agent.schema.json',str(p.relative_to(ROOT)))
    agents[d.get('id')]=d
    out=ROOT/d.get('output_schema','')
    if not out.exists(): err(f'{p.name}: output schema missing {d.get("output_schema")}')
    for fx in d.get('fixtures',[]):
        if not (ROOT/fx).exists(): err(f'{p.name}: fixture missing {fx}')
# v3 role separation assertions.
ev_schema=schemas.get('evidence-verdict.schema.json',{}).get('properties',{})
cur_schema=schemas.get('curiosity-plan.schema.json',{}).get('properties',{})
if 'children' in ev_schema: err('EvidenceVerdict schema must not contain children')
if 'verdict' in cur_schema or 'facet_states' in cur_schema: err('CuriosityPlan schema must not revise evidence verdict/facet states')
if 'agent-evidence-critic' not in agents or 'agent-curiosity-planner' not in agents: err('v3 split agents missing')

# Workflows.
workflows={}
for p in sorted((ROOT/'workflows').glob('*.yaml')):
    d=load(p)
    if not d: continue
    validate_obj(d,'workflow.schema.json',str(p.relative_to(ROOT)))
    workflows[d.get('id')]=d
for wid,d in workflows.items():
    steps=d.get('steps',[]); ids=[x.get('id') for x in steps]; terminals=set(d.get('terminal_states',[])); allowed=set(ids)|terminals
    if len(ids)!=len(set(ids)): err(f'{wid}: duplicate step ids')
    for st in steps:
        for key in ('on_success','on_failure'):
            if st.get(key) not in allowed: err(f'{wid}/{st.get("id")}: dangling {key} {st.get(key)}')
        if st.get('kind')=='agent' and st.get('uses') not in agents: err(f'{wid}/{st.get("id")}: missing agent {st.get("uses")}')
        if st.get('kind')=='subworkflow' and st.get('uses') not in workflows: err(f'{wid}/{st.get("id")}: missing subworkflow {st.get("uses")}')
    # Reachability from first step.
    if steps:
        seen=set(); q=deque([steps[0]['id']]); by={x['id']:x for x in steps}
        while q:
            x=q.popleft()
            if x in seen: continue
            seen.add(x)
            if x in by:
                for y in (by[x]['on_success'],by[x]['on_failure']):
                    if y in by and y not in seen:q.append(y)
        unreachable=set(ids)-seen
        if unreachable: err(f'{wid}: unreachable steps {sorted(unreachable)}')

# Agent fixtures.
for p in sorted((ROOT/'tests/agent-fixtures').glob('*.yaml')):
    d=load(p)
    if not d: continue
    if d.get('agent_id') not in agents: err(f'{p.name}: unknown agent {d.get("agent_id")}')
    if not d.get('assertions'): err(f'{p.name}: no assertions')

# Example records.
manifest=load(ROOT/'examples/records/manifest.yaml') or {}
record_objs={}; records_by_id={}
for item in manifest.get('records',[]):
    path=ROOT/'examples'/item['path']; schema_name=Path(item['schema']).name
    if not path.exists(): err(f'example missing {path.relative_to(ROOT)}'); continue
    obj=load(path)
    if obj is None: continue
    validate_obj(obj,schema_name,str(path.relative_to(ROOT)))
    record_objs[path.name]=obj
    if isinstance(obj,dict) and obj.get('id'):
        if obj['id'] in records_by_id: err(f'duplicate example id {obj["id"]}')
        records_by_id[obj['id']]=obj

# Source example integrity.
source_dir=ROOT/'examples/source-corpus'
source_files={}
source_units={}
for name,obj in record_objs.items():
    if name.startswith('source-file-'):
        p=source_dir/obj['normalized_path']
        if not p.exists(): err(f'{name}: source file missing {p.name}'); continue
        if sha(p)!=obj['blob_sha256']: err(f'{name}: file hash mismatch')
        source_files[obj['id']]=obj
    if name.startswith('source-unit-'):
        source_units[obj['id']]=obj
for uid,u in source_units.items():
    sf=source_files.get(u['source_file_id'])
    if not sf: err(f'{uid}: source_file_id missing'); continue
    p=source_dir/sf['normalized_path']; lines=p.read_text().splitlines(keepends=True)
    loc=u['normalized_locator']; text=''.join(lines[loc['line_start']-1:loc['line_end']])
    if hashlib.sha256(text.encode()).hexdigest()!=u['unit_sha256']: err(f'{uid}: unit hash/locator mismatch')
# Verify all reference-shaped objects recursively.
def walk_refs(x,label):
    if isinstance(x,dict):
        if {'source_file_id','source_unit_id','file_sha256','unit_sha256','snapshot_id'}.issubset(x):
            sf=source_files.get(x['source_file_id']); u=source_units.get(x['source_unit_id'])
            if not sf: err(f'{label}: reference source_file_id missing {x["source_file_id"]}')
            elif sf['blob_sha256']!=x['file_sha256']: err(f'{label}: reference file hash mismatch')
            if not u: err(f'{label}: reference source_unit_id missing {x["source_unit_id"]}')
            elif u['unit_sha256']!=x['unit_sha256']: err(f'{label}: reference unit hash mismatch')
        for k,v in x.items(): walk_refs(v,f'{label}/{k}')
    elif isinstance(x,list):
        for i,v in enumerate(x): walk_refs(v,f'{label}/{i}')
for name,obj in record_objs.items(): walk_refs(obj,name)
# Cross-reference key records.
for name,obj in record_objs.items():
    for key in ('accepted_claim_ids','claim_ids','dependency_claim_ids','question_ids','linked_question_ids','linked_claim_ids','obligation_ids','satisfaction_artifact_ids'):
        vals=obj.get(key,[]) if isinstance(obj,dict) else []
        for rid in vals:
            if rid not in records_by_id: err(f'{name}: unresolved {key} id {rid}')
    if isinstance(obj,dict) and obj.get('answer_id') and obj['answer_id'] not in records_by_id: err(f'{name}: unresolved answer_id')
# Intentional external IDs not all checked (run/branch/index/policy).

# Work packages and tasks.
wp_files=sorted((ROOT/'plan/tasks').glob('*.yaml')); wp_ids=set(); wp_objs={}; tasks={}
for p in wp_files:
    d=load(p)
    if not d: continue
    for field in ('schema_version','id','phase','title','description','goals','dependencies','exit_gate','tasks'):
        if field not in d: err(f'{p.name}: missing {field}')
    wpid=d.get('id'); wp_ids.add(wpid); wp_objs[wpid]=d
    for t in d.get('tasks',[]):
        validate_obj(t,'task.schema.json',f'{p.name}/{t.get("id")}')
        if t.get('work_package_id')!=wpid: err(f'{t.get("id")}: work package mismatch')
        if t.get('id') in tasks: err(f'duplicate task id {t.get("id")}')
        tasks[t.get('id')]=t
for wpid,d in wp_objs.items():
    for dep in d.get('dependencies',[]):
        if dep not in wp_ids: err(f'{wpid}: missing WP dependency {dep}')
for tid,t in tasks.items():
    for dep in t.get('dependencies',[]):
        if dep not in tasks: err(f'{tid}: missing task dependency {dep}')
# Cycle detection generic.
def check_cycle(nodes,edges,label):
    indeg={n:0 for n in nodes}; out=defaultdict(list)
    for n in nodes:
        for d in edges(n):
            if d in indeg: out[d].append(n); indeg[n]+=1
    q=deque([n for n,v in indeg.items() if v==0]); count=0
    while q:
        n=q.popleft(); count+=1
        for m in out[n]:
            indeg[m]-=1
            if indeg[m]==0:q.append(m)
    if count!=len(nodes): err(f'{label}: dependency cycle detected')
check_cycle(wp_ids,lambda n:wp_objs[n].get('dependencies',[]),'work packages')
check_cycle(set(tasks),lambda n:tasks[n].get('dependencies',[]),'tasks')
# Flattened task index agreement.
idx=[json.loads(line) for line in (ROOT/'plan/task-index.jsonl').read_text().splitlines() if line.strip()]
if len(idx)!=len(tasks): err(f'task-index count {len(idx)} != tasks {len(tasks)}')
if {x['id'] for x in idx}!=set(tasks): err('task-index IDs differ from package tasks')
if len(wp_ids)<25 or len(tasks)<75: err('plan is not comprehensive enough for configured minimum')

# Source supplied file manifest.
sm=load(ROOT/'source/source-manifest.yaml') or {}
for item in sm.get('files',[]):
    p=ROOT/'source'/item['path']
    if not p.exists(): err(f'source manifest missing {item["path"]}')
    elif sha(p)!=item['sha256']: err(f'source manifest hash mismatch {item["path"]}')

# Diagrams.
for p in sorted((ROOT/'diagrams').glob('*.dot')):
    svg=p.with_suffix('.svg'); mmd=p.with_suffix('.mmd')
    if not svg.exists(): err(f'diagram render missing {svg.name}')
    if not mmd.exists(): err(f'mermaid source missing {mmd.name}')
if not (ROOT/'architecture.html').exists(): err('architecture.html missing')
if not (ROOT/'plan/dependency-graph.svg').exists(): err('plan dependency graph missing')

# Relative Markdown/HTML links.
link_re=re.compile(r'\[[^\]]*\]\(([^)]+)\)')
for p in sorted(list(ROOT.glob('*.md'))+list((ROOT/'plan').glob('*.md'))):
    text=p.read_text()
    for target in link_re.findall(text):
        target=target.strip().split('#',1)[0]
        if not target or '://' in target or target.startswith('mailto:'): continue
        dest=(p.parent/target).resolve()
        try: dest.relative_to(ROOT.resolve())
        except ValueError: err(f'{p.relative_to(ROOT)}: link escapes bundle {target}'); continue
        if not dest.exists(): err(f'{p.relative_to(ROOT)}: broken link {target}')


# Integrity manifest (excludes the manifest and validation report themselves).
manifest_path=ROOT/'MANIFEST.sha256'
if manifest_path.exists():
    listed={}
    for line in manifest_path.read_text().splitlines():
        if not line.strip(): continue
        try: digest, rel=line.split('  ',1)
        except ValueError:
            err(f'MANIFEST.sha256 malformed line: {line}'); continue
        listed[rel]=digest
        fp=ROOT/rel
        if not fp.exists(): err(f'MANIFEST.sha256 missing file {rel}')
        elif sha(fp)!=digest: err(f'MANIFEST.sha256 hash mismatch {rel}')
    excluded={'MANIFEST.sha256','VALIDATION.md'}
    actual={str(x.relative_to(ROOT)) for x in ROOT.rglob('*') if x.is_file() and str(x.relative_to(ROOT)) not in excluded}
    if set(listed)!=actual:
        missing=sorted(actual-set(listed)); extra=sorted(set(listed)-actual)
        if missing: err(f'MANIFEST.sha256 unlisted files {missing}')
        if extra: err(f'MANIFEST.sha256 extra files {extra}')

# Forbidden build/runtime artifacts.
forbidden_ext={'.db','.sqlite','.sqlite3','.faiss','.index','.npy','.npz','.mp3','.wav','.zip','.tar','.gz','.pyc'}
for p in ROOT.rglob('*'):
    if p.is_file() and p.suffix.lower() in forbidden_ext: err(f'forbidden committed artifact {p.relative_to(ROOT)}')
    if '__pycache__' in p.parts: err(f'forbidden pycache {p.relative_to(ROOT)}')

if errors:
    print('FAILED')
    for e in errors: print('- '+e)
    sys.exit(1)
print(f'OK: validated {sum(1 for p in ROOT.rglob("*") if p.is_file())} files')
print(f'- schemas: {len(schemas)}')
print(f'- agents: {len(agents)}')
print(f'- workflows: {len(workflows)}')
print(f'- example records: {len(manifest.get("records",[]))}')
print(f'- work packages: {len(wp_ids)}')
print(f'- leaf tasks: {len(tasks)}')
print(f'- diagrams: {len(list((ROOT/"diagrams").glob("*.dot")))}')
