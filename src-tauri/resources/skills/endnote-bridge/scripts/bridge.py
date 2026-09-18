#!/usr/bin/env python3
"""Offline bibliography exchange. Writes a proposal, never the existing library."""
import argparse
import hashlib
import json
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path


def identity(record):
    doi = re.sub(r"^https?://(?:dx\.)?doi\.org/", "", record.get("doi", "").strip(), flags=re.I).lower()
    return "doi:" + doi if doi else "title:" + re.sub(r"\W+", "", record.get("title", "").casefold())


def decode_bib_text(value):
    # Preserve escaped literals; strip only TeX grouping, reject macros requiring a real TeX parser.
    out = []
    i = 0
    while i < len(value):
        char = value[i]
        if char == chr(92):
            if i + 1 >= len(value):
                raise ValueError('TeX macro/accent requires an explicit Unicode export before exchange')
            nxt = value[i + 1]
            if nxt in '&%_#{}$':
                out.append(nxt); i += 2; continue
            # BibTeX 引号转义 \"word，不是 TeX 变音 \"o / \"{o}
            if nxt == '"':
                rest = value[i + 2:]
                if rest.startswith('{') or (rest[:1].isalpha() and not rest[1:2].isalpha()):
                    raise ValueError('TeX macro/accent requires an explicit Unicode export before exchange')
                out.append('"'); i += 2; continue
            raise ValueError('TeX macro/accent requires an explicit Unicode export before exchange')
        if char not in '{}': out.append(char)
        i += 1
    return ''.join(out)


def bib_records(text):
    records = []
    pos = 0
    while pos < len(text):
        match = re.search(r"@([\w-]+)\s*\{", text[pos:])
        if not match:
            if text[pos:].strip() and not all(not x.strip() or x.lstrip().startswith('%') for x in text[pos:].splitlines()):
                raise ValueError("Unparsed BibTeX content; refusing lossy conversion")
            break
        kind = match[1].lower()
        if kind in ("string", "preamble"):
            raise ValueError("BibTeX macros/preamble require expansion before conversion")
        start = pos + match.end()
        depth, quote, escaped, end = 1, False, False, start
        while end < len(text) and depth:
            ch = text[end]
            if escaped:
                escaped = False
            elif ch == '\\':
                escaped = True
            elif ch == '"' and depth == 1:
                quote = not quote
            elif not quote:
                depth += (ch == '{') - (ch == '}')
            end += 1
        if depth:
            raise ValueError("Unclosed BibTeX record")
        body = text[start:end - 1]
        pos = end
        if kind == 'comment':
            continue
        key, sep, body = body.partition(',')
        if not sep or not key.strip():
            raise ValueError("Missing BibTeX citation key")
        record = {'id': key.strip(), 'type': kind}
        while body.strip(' ,\r\n\t'):
            body = body.lstrip(' ,\r\n\t')
            field = re.match(r'([\w-]+)\s*=\s*', body)
            if not field:
                raise ValueError("Unsupported BibTeX field expression")
            name = field[1].lower()
            body = body[field.end():]
            if not body:
                raise ValueError("Missing field value")
            opening = body[0]
            if opening in '{"':
                depth, escaped, i = 1, False, 1
                while i < len(body) and depth:
                    ch = body[i]
                    if escaped:
                        escaped = False
                    elif ch == '\\':
                        escaped = True
                    elif opening == '{':
                        depth += (ch == '{') - (ch == '}')
                    elif ch == '"':
                        depth = 0
                    i += 1
                if depth:
                    raise ValueError("Unclosed BibTeX value")
                value, body = body[1:i-1], body[i:]
            else:
                value, comma, body = body.partition(',')
                if not value.strip().isdigit():
                    raise ValueError("Unexpanded BibTeX macro")
            record[name] = value.strip()
        record['authors'] = re.split(r'\s+and\s+', record.pop('author', '')) if record.get('author') else []
        record['journal'] = record.get('journal') or record.get('booktitle', '')
        record['authors'] = [decode_bib_text(a) for a in record['authors']]
        for key, value in list(record.items()):
            if key not in ('authors', 'id', 'type') and isinstance(value, str):
                record[key] = decode_bib_text(value)
        records.append(record)
    return records


def load(path):
    with path.open('rb') as source:
        data = source.read(32 * 1024 * 1024 + 1)
    if len(data) > 32 * 1024 * 1024:
        raise ValueError('Bibliography exceeds 32 MiB')
    text = data.decode('utf-8-sig')
    if path.suffix.lower() == '.bib':
        return bib_records(text)
    if path.suffix.lower() == '.xml':
        if '<!DOCTYPE' in text.upper() or '<!ENTITY' in text.upper():
            raise ValueError('DTD/entities are not allowed')
        root = ET.fromstring(text)
        result = []
        for item in root.findall('.//record'):
            def value(name):
                el = item.find(name)
                return ''.join(el.itertext()).strip() if el is not None else ''
            result.append({'id': value('label'), 'sourceRecordNumber': value('rec-number'), 'type': {'17': 'article', '6': 'book', '5': 'incollection', '47': 'inproceedings', '32': 'phdthesis'}.get(value('ref-type'), 'misc'),
                'title': value('titles/title'), 'journal': value('titles/secondary-title'),
                'authors': [''.join(a.itertext()).strip() for a in item.findall('contributors/authors/author')],
                'year': value('dates/year'), 'doi': value('electronic-resource-num'),
                'volume': value('volume'), 'number': value('number'), 'pages': value('pages'),
                'url': value('urls/web-urls/url'), 'isbn': value('isbn'),
                'attachments': [''.join(a.itertext()).strip() for a in item.findall('urls/pdf-urls/url')], 'sourceXml': ET.tostring(item,encoding='unicode')})
        if not result and root.tag != 'xml':
            raise ValueError('Not EndNote XML')
        return result
    if path.suffix.lower() == '.ris':
        result, current, last = [], None, None
        fields = {'TI':'title', 'T1':'title', 'JO':'journal', 'JF':'journal', 'T2':'journal', 'PY':'year', 'Y1':'year', 'DO':'doi', 'VL':'volume', 'IS':'number', 'SP':'pages', 'UR':'url', 'ID':'id', 'SN':'isbn'}
        for line in text.splitlines():
            if not line.strip():
                continue
            m = re.match(r'^([A-Z0-9]{2})\s{2}-\s?(.*)$', line)
            if not m:
                if current is not None and last:
                    current[last] = str(current.get(last, '')) + ' ' + line.strip()
                    continue
                raise ValueError('Invalid RIS line')
            tag, value = m.groups()
            if tag == 'TY':
                if current is not None:
                    raise ValueError('RIS record missing ER')
                current = {'type': {'JOUR':'article','BOOK':'book','CHAP':'incollection','CONF':'inproceedings','THES':'phdthesis'}.get(value,'misc'), 'authors': [], 'attachments': []}
            elif tag == 'ER':
                if current is None:
                    raise ValueError('RIS ER without record')
                result.append(current); current = None
            elif current is None:
                raise ValueError('RIS record missing TY')
            elif tag in ('AU', 'A1'):
                current['authors'].append(value); last = None
            elif tag == 'L1':
                current['attachments'].append(value); last = None
            elif tag == 'EP':
                current['pages'] = current.get('pages', '') + '--' + value
            elif tag in fields:
                last = fields[tag]; current[last] = value
            else:
                current.setdefault('risFields', {}).setdefault(tag, []).append(value)
                last = None
        if current is not None:
            raise ValueError('RIS record missing ER')
        return result
    raise ValueError('Input must be UTF-8 .bib, .xml or .ris')


def escape_bib(value):
    return ''.join('\\'+c if c in '&%_#{}$' else c for c in str(value))


def family_comma(author):
    # EndNote/RIS 作者按「姓, 名」解析；OpenAlex 等「名 姃」无逗号串会整串进姓字段，
    # 引用就成 (Jinlong et al., 2026)。无逗号多词名翻转为末词作姓；末词本身是
    # 缩写（PubMed 风格 Smith JM）时首词才是姓。已带逗号或单词名原样保留。
    name = str(author).strip()
    if not name or ',' in name:
        return author
    tokens = name.split()
    if len(tokens) < 2:
        return author
    last = tokens[-1].replace('.', '')
    if last.isalpha() and last.isupper() and len(last) <= 3:
        return tokens[0] + ', ' + ' '.join(tokens[1:])
    return tokens[-1] + ', ' + ' '.join(tokens[:-1])


def render(records, suffix):
    if suffix == '.xml':
        # EndNote.dtd：ref-type/@name 必填，record 子元顺序固定。缺 name 或顺序错会静默导入 0 条。
        type_code = {'article':17,'book':6,'incollection':5,'inproceedings':47,'phdthesis':32}
        type_name = {17:'Journal Article',6:'Book',5:'Book Section',47:'Conference Paper',32:'Thesis',13:'Generic'}
        root = ET.Element('xml'); rows = ET.SubElement(root, 'records')
        for i, r in enumerate(records, 1):
            item = ET.SubElement(rows, 'record')
            def put(path, value, attrs=None):
                parent = item
                parts = path.split('/')
                for part in parts[:-1]:
                    child = parent.find(part)
                    if child is None:
                        child = ET.SubElement(parent, part)
                    parent = child
                el = ET.SubElement(parent, parts[-1], attrs or {})
                el.text = str(value)
            code = type_code.get(r.get('type'), 13)
            ET.SubElement(item, 'source-app', {'name':'EndNote','version':'21.0'}).text = 'EndNote'
            put('rec-number', i)
            put('ref-type', code, {'name': type_name.get(code, 'Generic')})
            for author in r.get('authors', []): put('contributors/authors/author', family_comma(author))
            if r.get('title'): put('titles/title', r['title'])
            if r.get('journal'): put('titles/secondary-title', r['journal'])
            if r.get('pages'): put('pages', r['pages'])
            if r.get('volume'): put('volume', r['volume'])
            if r.get('number'): put('number', r['number'])
            if r.get('year'): put('dates/year', r['year'])
            if r.get('isbn'): put('isbn', r['isbn'])
            put('label', r['id'])
            if r.get('url'): put('urls/web-urls/url', r['url'])
            for attachment in r.get('attachments', []): put('urls/pdf-urls/url', attachment)
            if r.get('doi'): put('electronic-resource-num', r['doi'])
        return ET.tostring(root, encoding='unicode', xml_declaration=True) + '\n'
    if suffix == '.ris':
        def line(tag, value):
            return f'{tag}  - {str(value).replace(chr(13), " ").replace(chr(10), " ")}'
        def split_pages(pages):
            s = str(pages).replace('–', '-').replace('—', '-').replace('−', '-')
            if '-' in s:
                a, b = s.split('-', 1)
                return a.strip(), b.strip()
            return s.strip(), ''
        result = []
        for r in records:
            result.append(line('TY', {'article':'JOUR','book':'BOOK','incollection':'CHAP','inproceedings':'CONF','phdthesis':'THES'}.get(r.get('type'), 'JOUR')))
            for author in r.get('authors', []):
                result.append(line('AU', family_comma(author)))
            if r.get('title'):
                result.append(line('TI', r['title']))
            if r.get('journal'):
                result.append(line('JO', r['journal']))
                result.append(line('T2', r['journal']))
            if r.get('year'):
                result.append(line('PY', r['year']))
            if r.get('doi'):
                result.append(line('DO', r['doi']))
            if r.get('volume'):
                result.append(line('VL', r['volume']))
            if r.get('number'):
                result.append(line('IS', r['number']))
            if r.get('pages'):
                start, end = split_pages(r['pages'])
                if start:
                    result.append(line('SP', start))
                if end:
                    result.append(line('EP', end))
            if r.get('url'):
                result.append(line('UR', r['url']))
            for attachment in r.get('attachments', []):
                result.append(line('L1', attachment))
            result.append('ER  - ')
            result.append('')
        # EndNote 认 CRLF。不要加 BOM：带 BOM 时不认 TY 行，会跳过格式选择、静默导入 0 条。
        return '\r\n'.join(result) + '\r\n'
    if suffix == '.enw':
        def split_pages(pages):
            s = str(pages).replace('–', '-').replace('—', '-').replace('−', '-')
            if '-' in s:
                a, b = s.split('-', 1)
                return a.strip(), b.strip()
            return s.strip(), ''
        type_name = {'article':'Journal Article','book':'Book','incollection':'Book Section','inproceedings':'Conference Paper','phdthesis':'Thesis'}
        result = []
        for r in records:
            result.append('%0 ' + type_name.get(r.get('type'), 'Journal Article'))
            for author in r.get('authors', []):
                result.append('%A ' + family_comma(author))
            if r.get('year'):
                result.append('%D ' + str(r['year']).replace('\n', ' '))
            if r.get('title'):
                result.append('%T ' + str(r['title']).replace('\n', ' '))
            if r.get('journal'):
                result.append('%J ' + str(r['journal']).replace('\n', ' '))
            if r.get('volume'):
                result.append('%V ' + str(r['volume']))
            if r.get('number'):
                result.append('%N ' + str(r['number']))
            if r.get('pages'):
                start, end = split_pages(r['pages'])
                result.append('%P ' + (f'{start}-{end}' if end else start))
            if r.get('doi'):
                result.append('%R ' + str(r['doi']))
            if r.get('url'):
                result.append('%U ' + str(r['url']))
            result.append('%F ' + r['id'])
            result.append('')
        return '\r\n'.join(result) + '\r\n'
    if suffix == '.bib':
        result = []
        for r in records:
            fields = {k:r[k] for k in ('title','journal','year','doi','volume','number','pages','url','isbn') if r.get(k)}
            if r.get('authors'): fields['author'] = ' and '.join(r['authors'])
            if any('\n@' in str(v) or str(v).count('{') != str(v).count('}') for v in fields.values()):
                raise ValueError('Unsafe/unbalanced BibTeX value; inspect proposal JSON')
            result.append('@'+r.get('type','misc')+'{'+r['id']+',\n'+''.join(f'  {k} = {{{escape_bib(v)}}},\n' for k,v in fields.items())+'}\n')
        return '\n'.join(result)
    if suffix == '.json': return json.dumps(records,ensure_ascii=False,indent=2)+'\n'
    raise ValueError('Output must be .xml, .ris, .bib or .json')


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--input',type=Path,required=True);p.add_argument('--output',type=Path,required=True)
    p.add_argument('--report',type=Path,required=True);p.add_argument('--existing',type=Path)
    a=p.parse_args()
    try:
        records=load(a.input); existing=load(a.existing) if a.existing else []
        for dest in (a.output,a.report):
            if dest.exists() or dest.is_symlink(): raise ValueError('Output exists; choose a new proposal path')
        if a.output.resolve()==a.report.resolve(): raise ValueError('Report and proposal paths must differ')
        old={}
        for record in existing:
            key=identity(record)
            if key in old:raise ValueError('Ambiguous existing duplicate DOI/title; resolve before matching citation keys')
            old[key]=record
        seen=set();unique=[];changes=[];warnings=[];keys=set()
        for r in records:
            if not r.get('title','').strip(): raise ValueError('Missing title; refusing silent record loss')
            key=identity(r)
            if key in seen: warnings.append({'duplicate':key});continue
            seen.add(key)
            prior=old.get(key)
            raw=(prior or r).get('id') or 'ref'+hashlib.sha256(key.encode()).hexdigest()[:12]
            if not re.fullmatch(r'[\w:.-]+',raw): raw='ref'+hashlib.sha256(key.encode()).hexdigest()[:12]
            if raw in keys: raw+='-'+hashlib.sha256(key.encode()).hexdigest()[:8]
            r['id']=raw;keys.add(raw)
            delta={k:{'before':(prior or {}).get(k),'after':v} for k,v in r.items() if k!='id' and v!=(prior or {}).get(k)}
            changes.append({'id':raw,'identity':key,'status':'changed' if prior and delta else 'unchanged' if prior else 'new','fields':delta})
            for field in ('year','authors','doi'):
                if not r.get(field):warnings.append({'id':raw,'missing':field})
            supported={'id','type','title','authors','journal','booktitle','year','doi','volume','number','pages','url','isbn','attachments','sourceRecordNumber'}
            extras={k:v for k,v in r.items() if k not in supported}
            if extras: warnings.append({'id':raw,'notMappedFields':extras})
            if a.output.suffix.lower()=='.bib' and r.get('attachments'):warnings.append({'id':raw,'attachmentsInReportOnly':r['attachments']})
            unique.append(r)
        output=render(unique,a.output.suffix.lower())
        report={'inputCount':len(records),'outputCount':len(unique),'inputSha256':hashlib.sha256(a.input.read_bytes()).hexdigest(),'existingUnchanged':True,'proposalOnly':True,'changes':changes,'warnings':warnings,'normalizedRecords':unique,
            'manualChecks':['Confirm diff before merging the main bibliography','Import XML using EndNote XML / RIS using Reference Manager (RIS); verify in your EndNote version','Author names flipped to "Family, Given" (heuristic for given-first sources); spot-check hyphenated or Chinese-order names','Check attachment resolution and Word plugin citations manually']}
        for path,text in [(a.output,output),(a.report,json.dumps(report,ensure_ascii=False,indent=2)+'\n')]:
            path.parent.mkdir(parents=True,exist_ok=True)
            with path.open('x',encoding='utf-8',newline='\n') as f:f.write(text)
        return 0
    except (OSError, ValueError, ET.ParseError) as e:
        print(str(e),file=sys.stderr);return 1

if __name__=='__main__':sys.exit(main())
