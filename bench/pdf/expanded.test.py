#!/usr/bin/env python3
"""Run: PATH=/opt/homebrew/bin:$PATH python3 bench/pdf/expanded.test.py"""
from collections import Counter
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tempfile
import sys

sys.dont_write_bytecode = True
from expanded import CATEGORIES, INK, WHITE, contrast, generate


def words(case, root):
    return Counter(subprocess.check_output(['pdftotext','-raw',str(root/case['path']),'-'], text=True).split())


def main():
    with tempfile.TemporaryDirectory(prefix='expanded-check-') as temp:
        root=Path(temp)/'corpus'
        key=generate(root,render=False)
        cases=key['cases']
        assert key['version']=='2'
        assert len(cases)==24
        assert len({c['sha256'] for c in cases})==24
        assert Counter(d['category'] for c in cases for d in c['expectedDefects'])==Counter({c:6 for c in CATEGORIES})
        assert all(len(c['expectedDefects'])==(3 if c['variant']=='flawed' else 0) for c in cases)
        assert all(re.fullmatch(r'[0-9a-f]{20}',c['caseId']) for c in cases)
        assert all(p.suffix=='.pdf' for p in (root/'model-input').iterdir())
        assert len({c['layout'] for c in cases})==12
        assert {c['pageCount'] for c in cases}=={1,2}
        assert contrast(INK,WHITE)>10
        for c in cases:
            assert hashlib.sha256((root/c['path']).read_bytes()).hexdigest()==c['sha256']
            if c['layout']=='two-page-order':
                ops=c['pages'][0]['operations']
                label=next(o for o in ops if o.get('text')=='Stock code')
                assert label['size']>=11 and label['clipBox'] is None
                x,y=label['origin']
                fields=[o['box'] for o in ops if o['kind']=='rectangle' and not o['filled']
                        and o['box'][0]==x and 0<y-o['box'][1]-o['box'][3]<24]
                assert len(fields)==1
                fx,fy,fw,fh=fields[0]
                assert fw>=100 and fh>=28
                assert not any(o['kind']=='text' and fx<=o['origin'][0]<fx+fw
                               and fy<=o['origin'][1]<fy+fh for o in ops)
                assert words(c,root)['Stock']>=1 and words(c,root)['code']>=1
            for page in c['pages']:
                for op in page['operations']:
                    if op['kind']=='text' and op['font']=='F1':
                        x,y,w,h=op['advanceBox']
                        assert x>=0 and y>0 and x+w<page['width'] and y+h<page['height'], (c['caseId'],op)
            for d in c['expectedDefects']:
                p=c['pages'][d['page']-1]
                ops=[p['operations'][i] for i in d['operationIndices']]
                texts=[o for o in ops if o['kind']=='text']
                if d['category']=='clipping':
                    op=texts[0]
                    assert op['clipBox'][2] < op['advanceBox'][2]-50
                elif d['category']=='overlap':
                    a,b=texts
                    assert a['origin'][1]==b['origin'][1]
                    assert b['origin'][0]<a['origin'][0]+a['advanceBox'][2]
                elif d['category']=='small-essential-text':
                    assert texts[0]['size']==4
                elif d['category']=='low-text-contrast':
                    assert 1<d['contrastRatio']<2
                    assert abs(d['contrastRatio']-contrast(d['foreground'],d['background']))<1e-10
                elif d['category']=='color-only-meaning':
                    swatches=[o for o in ops if o['kind']=='rectangle']
                    assert len(swatches)==2
                    # The existing Poppler grayscale conversion uses encoded-channel luma.
                    luma=lambda rgb: sum(a*b for a,b in zip(rgb,(.299,.587,.114)))
                    assert abs(luma(swatches[0]['color'])-luma(swatches[1]['color']))<.002
                else:
                    assert len(texts)==7  # standalone note plus six data cells, no header
        for pair_id in {c['pairId'] for c in cases}:
            clean=next(c for c in cases if c['pairId']==pair_id and c['variant']=='clean')
            bad=next(c for c in cases if c['pairId']==pair_id and c['variant']=='flawed')
            assert clean['useContext']==bad['useContext']
            assert clean['pageCount']==bad['pageCount']
            assert words(clean,root)==words(bad,root)+Counter(' '.join(clean['cleanOnlyText']).split()), pair_id
            # The PDF source still carries clipped/overprinted text. Visual review must
            # establish visibility; extraction alone cannot prove those defects.
            source=lambda c: Counter(o['text'] for p in c['pages'] for o in p['operations'] if o['kind']=='text')
            assert source(clean)==source(bad)+Counter(clean['cleanOnlyText'])
        again=generate(Path(temp)/'again',render=False)
        assert key==again
        assert json.loads((root/'private-key.json').read_text())==key
    print('24 PDFs verified: pairing, text preservation, geometry, contrast, pages, hashes and deterministic IDs.')


if __name__=='__main__':
    main()
