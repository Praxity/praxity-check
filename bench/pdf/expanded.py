#!/usr/bin/env python3
"""Original synthetic visual controls. Run with a NEW output directory.

Only model-input/*.pdf and the corresponding useContext may reach a reviewer.
private-key.json includes author intent and drawing operations, never reviewer evidence.
Coordinates are PDF points from the bottom left. No PDF/UA pass is claimed.
"""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import random
import shutil
import subprocess

CATEGORIES = ('clipping', 'overlap', 'low-text-contrast', 'small-essential-text',
              'color-only-meaning', 'missing-table-context')
TRIPLES = ((0,1,2),(3,4,5),(0,1,3),(2,4,5),(0,2,4),(1,3,5),
           (0,3,5),(1,2,4),(0,4,5),(1,2,3),(0,2,5),(1,3,4))
INK = (0.12, 0.16, 0.20)
WHITE = (1,1,1)


def contrast(a, b):
    def luminance(c):
        return sum(w * (v / 12.92 if v <= .04045 else ((v+.055)/1.055)**2.4)
                   for w,v in zip((.2126,.7152,.0722), c))
    x,y = sorted((luminance(a), luminance(b)))
    return (y+.05)/(x+.05)


class Page:
    def __init__(self, width=612, height=792):
        self.width, self.height = width, height
        self.commands, self.facts = [], []

    def text(self, x, y, value, size=12, color=INK, font='F1', clip=None):
        value.encode('ascii')
        escaped = value.replace('\\', '\\\\').replace('(', '\\(').replace(')', '\\)')
        self.commands.append('q')
        if clip:
            self.commands.append(' '.join(map(str, clip)) + ' re W n')
        self.commands.append(f'{color[0]} {color[1]} {color[2]} rg BT /{font} {size} Tf 1 0 0 1 {x} {y} Tm ({escaped}) Tj ET Q')
        fact = dict(kind='text', text=value, origin=[x,y], font=font, size=size,
                    color=list(color), clipBox=clip)
        # Courier has exactly 600-unit advance. Other fonts export origins only.
        if font == 'F1':
            fact['advanceBox'] = [x, y, len(value)*size*.6, size]
        self.facts.append(fact)
        return fact

    def rect(self, x,y,w,h, fill=None):
        color = fill or INK
        self.commands.append(f'q {color[0]} {color[1]} {color[2]} ' + ('rg' if fill else 'RG') + f' .6 w {x} {y} {w} {h} re ' + ('f Q' if fill else 'S Q'))
        self.facts.append(dict(kind='rectangle', box=[x,y,w,h], color=list(color), filled=fill is not None))

    def line(self, x,y,x2,y2):
        self.commands.append(f'q .4 .45 .5 RG .6 w {x} {y} m {x2} {y2} l S Q')
        self.facts.append(dict(kind='line', start=[x,y], end=[x2,y2]))


def write_pdf(path, pages):
    # Same direct PDF object format as generate.py, with variable pages and fonts.
    objects = [b'<< /Type /Catalog /Pages 2 0 R >>', b'',
               b'<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>',
               b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>',
               b'<< /Type /Font /Subtype /Type1 /BaseFont /Times-Italic >>']
    kids = []
    for p in pages:
        n = len(objects)+1
        kids.append(f'{n} 0 R')
        stream = ('\n'.join(p.commands)+'\n').encode('ascii')
        objects.extend([f'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {p.width} {p.height}] /Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >> >> /Contents {n+1} 0 R >>'.encode(), f'<< /Length {len(stream)} >>\nstream\n'.encode()+stream+b'endstream'])
    objects[1] = f'<< /Type /Pages /Kids [{" ".join(kids)}] /Count {len(pages)} >>'.encode()
    data = bytearray(b'%PDF-1.4\n%\xe2\xe3\xcf\xd3\n')
    offsets = [0]
    for n,obj in enumerate(objects,1):
        offsets.append(len(data))
        data.extend(f'{n} 0 obj\n'.encode()+obj+b'\nendobj\n')
    start = len(data)
    data.extend(f'xref\n0 {len(offsets)}\n0000000000 65535 f \n'.encode())
    for offset in offsets[1:]:
        data.extend(f'{offset:010d} 00000 n \n'.encode())
    data.extend(f'trailer\n<< /Size {len(offsets)} /Root 1 0 R >>\nstartxref\n{start}\n%%EOF\n'.encode())
    path.write_bytes(data)


# Each entry is an original document purpose, layout and three independent tasks.
CASES = [
 dict(title='Open studio afternoon', context='Volunteers use this printed agenda to prepare and run a community art afternoon.', layout='agenda',
      modules=[('Room handover','Return the room key before 18:00.'), ('Attendance record','Adults','Children'), ('Before doors open','Count all chairs before opening.')]),
 dict(title='Seed library sorting card', context='Volunteers sort invented seed packets using a grayscale printout and record packet quantities. Each sheet must stand alone.', layout='sidebar',
      modules=[('Intake rule','Record the packet code on every tray.'), ('Packet destination','Packet H','Packet J','STORE','DRY'), ('Tray inventory','Tray','Packets','Slots','A','12','20','B','8','16')]),
 dict(title='Listening walk field log', context='Adult learners carry a landscape field log and write observations at two stops.', layout='field',
      modules=[('Meet again','Return to the west gate at 15:30.'), ('Two observations','Near sound','Far sound'), ('Recording rule','Write one location beside each sound.')]),
 dict(title='Gallery courier reference', context='Gallery volunteers interpret package measurements and route crates from grayscale reference sheets handed out independently.', layout='two-page-reference',
      modules=[('Packing rule','Keep the numbered face toward the lid.'), ('Crate destination','Crate K','Crate M','NORTH','SOUTH'), ('Crate measurements','Crate','Width cm','Mass kg','K','42','8','M','35','6')]),
 dict(title='Repair cafe bench map', context='Workshop hosts use a landscape grayscale bench map to put practice items at the right station. No powered tools are used.', layout='map',
      modules=[('End of session','Leave finished models on bench four.'), ('Bench access','Keep the centre aisle clear of bags.'), ('Model destination','Model P','Model Q','DESK','SHELF')]),
 dict(title='Poster printing order', context='A print-room volunteer fills out an order sheet and uses a separate stock reference page to select paper.', layout='two-page-order',
      modules=[('Order details','Copies','Sheets'), ('Stock rule','Use one stock code for the whole order.'), ('Stock reference','Code','Width mm','Count','L','210','60','M','297','40')]),
 dict(title='Story circle session plan', context='Facilitators run a story circle from a landscape session plan and use its timing table independently.', layout='timeline',
      modules=[('Closing instruction','Collect every prompt card before break.'), ('Turn rule','Give each speaker two minutes to begin.'), ('Session timings','Part','Minutes','People','Pair','15','2','Group','20','8')]),
 dict(title='Community tool checkout', context='Volunteers use a grayscale checkout form to record borrowing and separate return bins. Items are unpowered craft tools.', layout='form',
      modules=[('Borrowing record','Issued','Returned'), ('Return instruction','Bring the numbered pouch with the tool.'), ('Return bin','Pouch A','Pouch B','COUNT','FILE')]),
 dict(title='Puzzle club score sheet', context='Club members use a grayscale score sheet to identify round routes and read scoring limits. Pages are shared separately.', layout='score',
      modules=[('Round close','Put the answer slip inside the envelope.'), ('Round route','Round A','Round B','EAST','WEST'), ('Scoring limits','Round','Points','Minutes','A','12','8','B','20','15')]),
 dict(title='Photo archive contact sheet', context='Archive volunteers use a landscape contact sheet to label synthetic image placeholders and write two identifiers.', layout='contact',
      modules=[('Identifiers','Roll code','Frame code'), ('Naming instruction','Keep the original number in every name.'), ('Filing rule','File each sheet under its year folder.')]),
 dict(title='Paper bridge challenge', context='Adult workshop participants use a two-page challenge brief and a separately distributed material reference sheet. Measurements are for paper models.', layout='two-page-worksheet',
      modules=[('Build instruction','Use only paper from the material list.'), ('Test instruction','Write the span before adding any coins.'), ('Material reference','Paper','Length cm','Mass g','A','28','5','B','21','4')]),
 dict(title='Festival welcome desk', context='Welcome-desk volunteers follow a landscape grayscale shift sheet and route visitor cards.', layout='dashboard',
      modules=[('Shift count','Arrivals','Departures'), ('Desk rule','Record the card number before routing.'), ('Card destination','Bluebird','Oakleaf','HALL','TENT')]),
]


def furniture(p, case, page, total):
    name = case['layout']
    p.text(36,p.height-48,case['title'],24,font='F2')
    p.text(36,p.height-72, {'two-page-reference':'Package desk / reference', 'two-page-order':'Print room / order record', 'two-page-worksheet':'Design workshop / paper models'}.get(name, 'Community workshop / working copy'),12,font='F3')
    p.text(36,22,'Original synthetic practice material.',9)
    p.text(p.width-88,22,f'{page} / {total}',9)
    if page == 2:
        p.text(36,680,'Reference sheet',18,font='F2')
        p.text(36,656,'Keep this page with the items it describes.',11)
        p.text(36,130,'Space below reserved for a desk stamp.',11,font='F3')
        return
    if name == 'agenda':
        for y,time,label in [(668,'13:00','Set out materials'),(632,'13:30','Welcome and demonstration'),(596,'16:00','Pack away together')]:
            p.text(36,y,time,15,font='F2'); p.text(132,y,label,12)
        p.line(113,585,113,687)
    elif name == 'sidebar':
        p.rect(36,450,145,220,fill=(.91,.95,.91))
        for y,t in [(640,'CHECK FIRST'),(610,'Code present'),(580,'Envelope dry'),(550,'Date written')]: p.text(48,y,t,11)
        p.text(208,655,'One packet per row',18,font='F3')
        p.text(208,628,'Leave spare trays empty.',11)
    elif name == 'field':
        p.rect(36,398,720,94)
        p.text(48,468,'Stop 1: courtyard',14,font='F2'); p.text(418,468,'Stop 2: garden',14,font='F2')
        p.line(396,410,396,482)
        p.text(48,438,'Date: ______________',12); p.text(418,438,'Weather: ___________',12)
    elif name == 'two-page-reference':
        p.rect(370,415,185,240)
        p.text(386,625,'CRATE LABEL',14,font='F2'); p.text(386,575,'K / M',25)
        p.text(386,440,'Packing sketch',12,font='F3')
        p.text(36,666,'Check the label before wrapping.',11)
    elif name == 'map':
        for x,y,label in [(48,458,'1 / arrivals'),(292,458,'2 / models'),(536,458,'3 / supplies')]:
            p.rect(x,y-45,208,65,fill=(.92,.94,.96)); p.text(x+12,y,label,13,font='F2')
        p.text(48,380,'4 / completed models',15,font='F3')
        p.line(48,405,744,405)
    elif name == 'two-page-order':
        p.rect(36,584,540,96)
        p.text(48,652,'Requested by: _____________________',12)
        p.text(48,618,'Collection date: __________________',12)
        p.text(366,498,'Stock code',12)
        p.rect(366,448,145,32)
    elif name == 'timeline':
        p.line(48,442,732,442)
        for x,t,label in [(48,'10:00','Welcome'),(276,'10:15','Pair stories'),(504,'10:30','Share back')]:
            p.line(x,432,x,453); p.text(x,472,t,18,font='F2'); p.text(x,411,label,12)
    elif name == 'form':
        p.text(36,661,'Borrower: ______________________________',13)
        p.text(36,626,'Item code: __________   Due: ___________',13)
        p.line(36,605,576,605)
        p.rect(36,80,540,124); p.text(48,178,'Optional notes for the next volunteer',12,font='F3')
    elif name == 'score':
        p.text(36,669,'Team: ___________________',16,font='F2')
        for x,label in [(36,'ROUND A'),(318,'ROUND B')]:
            p.rect(x,530,258,100); p.text(x+12,603,label,14,font='F2'); p.text(x+12,556,'Score: _______',13)
    elif name == 'contact':
        for x in (36,280,524):
            p.rect(x,365,220,132,fill=(.93,.93,.91))
            p.line(x+18,388,x+70,460); p.line(x+70,460,x+150,388)
            p.text(x+18,375,'Sketch placeholder',10,font='F3')
    elif name == 'two-page-worksheet':
        p.text(36,664,'Build a bridge between two books.',15,font='F3')
        p.text(36,637,'Work in pairs. Compare two folded shapes.',11)
        p.rect(36,85,540,258); p.text(48,316,'Draw both ideas here before building.',12)
    elif name == 'dashboard':
        p.rect(36,400,168,94,fill=(.91,.94,.97))
        p.text(48,465,'SHIFT',12,font='F2'); p.text(48,433,'12:00-14:00',18,font='F2')
        p.text(236,470,'Desk lead: Rowan',15,font='F3')
        p.text(236,435,'Cards stay at this desk until counted.',11)


def positions(case):
    layout=case['layout']
    return {
        'agenda':[(1,36,538),(1,36,402),(1,36,274)],
        'sidebar':[(1,208,566),(1,208,426),(1,36,280)],
        'field':[(1,36,336),(1,414,336),(1,36,175)],
        'two-page-reference':[(1,36,568),(1,36,388),(2,36,570)],
        'map':[(1,36,335),(1,408,335),(1,36,178)],
        'two-page-order':[(1,36,531),(1,36,372),(2,36,570)],
        'timeline':[(1,36,342),(1,414,342),(1,36,180)],
        'form':[(1,36,551),(1,36,422),(1,36,307)],
        'score':[(1,36,479),(1,36,363),(1,318,363)],
        'contact':[(1,36,307),(1,414,307),(1,36,154)],
        'two-page-worksheet':[(1,36,566),(1,36,441),(2,36,570)],
        'dashboard':[(1,36,347),(1,414,347),(1,36,183)],
    }[layout]


def module(p, cat, args, x,y, flawed):
    title,*values=args
    p.text(x,y,title,14,font='F2')
    facts_start=len(p.facts)
    extra=[]
    if cat == 'clipping':
        text=values[0]
        # Last 11 characters vanish, while the title and initial instruction remain.
        width=(len(text)-11)*6.6
        clip=[x,y-45,width,22] if flawed else None
        p.text(x,y-34,text,11,clip=clip)
        desc=f'The required instruction "{text}" is cut off; its ending is invisible.'
        remedy='Remove the text clipping region so the complete instruction is visible.'
        box=[x,y-45,len(text)*6.6,22]
    elif cat == 'overlap':
        a,b=values
        p.text(x,y-33,a,12)
        bx=x+12 if flawed else x+165
        p.text(bx,y-33,b,12)
        for xx in (x,x+165): p.rect(xx,y-83,145,32)
        desc=f'The "{a}" and "{b}" field labels overprint each other, obscuring which value belongs in each field.'
        remedy=f'Place "{b}" above the second field, 165 points right of the first label.'
        box=[x,y-85,310,66]
    elif cat in ('low-text-contrast','small-essential-text'):
        size=4 if flawed and cat=='small-essential-text' else 11
        color=(.83,.83,.83) if flawed and cat=='low-text-contrast' else INK
        p.text(x,y-34,values[0],size,color)
        desc=(f'The essential instruction "{values[0]}" is pale gray on white, contrast {contrast(color,WHITE):.2f}:1.' if cat=='low-text-contrast' else f'The essential instruction "{values[0]}" is set at 4 points, too small for routine printed use.')
        remedy='Set the required instruction in dark ink at 11 points.'
        box=[x,y-40,len(values[0])*6.6,18]
    elif cat=='color-only-meaning':
        a,b,route_a,route_b=values
        p.text(x,y-25,'Grayscale desk copy.',10,font='F3')
        p.text(x,y-46,f'Red: {route_a} / Green: {route_b}',10)
        for yy,label,route,color in [(y-70,a,route_a,(.8,0,0)),(y-95,b,route_b,(0,.407,0))]:
            p.rect(x,yy-2,12,12,fill=color)
            p.text(x+23,yy,label,11)
            if not flawed:
                p.text(x+148,yy,route,11)
                extra.append(route)
        desc=f'The {a}/{b} assignments rely only on red/green swatches despite intended grayscale use; destinations {route_a}/{route_b} cannot be recovered reliably from the printed swatches.'
        remedy=f'Write {route_a} beside {a} and {route_b} beside {b}, retaining the color marks.'
        box=[x,y-100,300,85]
    else:
        h1,h2,h3,a,b,c,d,e,f=values
        p.text(x,y-26,'Use this table on its own.',10,font='F3')
        if not flawed:
            for xx,value in zip((x,x+90,x+192),(h1,h2,h3)):
                p.text(xx,y-53,value,10); extra.append(value)
        p.line(x,y-65,x+264,y-65)
        for yy,row in [(y-86,(a,b,c)),(y-112,(d,e,f))]:
            for xx,value in zip((x,x+90,x+192),row): p.text(xx,yy,value,11)
        desc=f'The standalone table lacks the column labels and units "{h1}", "{h2}", "{h3}"; the numeric columns have no visible meaning.'
        remedy=f'Restore the header row {h1} / {h2} / {h3} above the values.'
        box=[x,y-120,264,85]
    result = dict(category=cat,description=desc,expected_remedy=remedy,box=box,
                  operationIndices=list(range(facts_start,len(p.facts))))
    if cat == 'low-text-contrast':
        result.update(foreground=list(color), background=list(WHITE), contrastRatio=contrast(color,WHITE))
    return result,extra


def make_case(index, flawed):
    case=CASES[index]
    landscape=case['layout'] in ('field','map','timeline','contact','dashboard')
    count=2 if case['layout'].startswith('two-page') else 1
    pages=[Page(792,612) if landscape else Page() for _ in range(count)]
    for n,p in enumerate(pages,1): furniture(p,case,n,count)
    defects=[]; allowed=[]
    for n,(category,args,pos) in enumerate(zip(TRIPLES[index],case['modules'],positions(case)),1):
        page,x,y=pos
        d,extra=module(pages[page-1],CATEGORIES[category],args,x,y,flawed)
        d.update(id=f'P{index+1:02d}-D{n}',page=page)
        if flawed: defects.append(d)
        allowed.extend(extra)
    # One ordinary hyphenated word and intentional spare space are negative controls.
    if case['layout']=='two-page-reference':
        pages[0].text(36,214,'Copy the number the scale dis-',11)
        pages[0].text(36,198,'plays, including its units.',11)
    return pages,defects,allowed


def generate(out, seed=20260914, render=True):
    for tool in ('pdfinfo','pdftotext','pdftoppm'):
        if not shutil.which(tool): raise RuntimeError(f'Add Poppler {tool} to PATH')
    out=Path(out); out.mkdir(parents=True,exist_ok=False)
    inputs=out/'model-input'; inputs.mkdir()
    renders=out/'renders'
    if render: renders.mkdir()
    rng=random.Random(seed)
    # Shuffle documents first; opaque IDs are drawn independently of case/variant.
    order=[(i,v) for i in range(12) for v in (False,True)]; rng.shuffle(order)
    key=dict(schemaVersion='pdf-expanded-private-1',seed=seed,
             corpusId='original-workplace-expanded',version='2',
             generatorSha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
             coordinateSystem='PDF points, origin bottom left; boxes are x,y,width,height',
             categories=list(CATEGORIES),cases=[],
             negativeControls=['Open space around agenda and reference blocks supports quick scanning.',
                               'Blank sketch, note and stamp areas have explicit intended uses.',
                               'Landscape columns, asymmetric sidebars and reference-page whitespace are intentional.',
                               'Courier body, bold sans-serif headings and italic notes have different roles.',
                               'P04 page 1 uses ordinary dis-/plays line-end hyphenation.'],
             limitations=['Author-created synthetic visual controls, not independent real-world documents.',
                          'Untagged standard-font PDFs intentionally share accessibility-structure failures.',
                          'Source drawing facts are for author verification only, never reviewer evidence.',
                          'Small-essential-text replaces subjective ambiguous-grouping before evaluation.'])
    for i,flawed in order:
        file_id=f'{rng.getrandbits(80):020x}'
        pages,defects,allowed=make_case(i,flawed)
        path=inputs/f'{file_id}.pdf'; write_pdf(path,pages)
        info=subprocess.check_output(['pdfinfo',str(path)],text=True)
        assert int(next(line.split(':')[1] for line in info.splitlines() if line.startswith('Pages:')))==len(pages)
        if render:
            subprocess.run(['pdftoppm','-scale-to','1400','-png',str(path),str(renders/file_id)],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
        key['cases'].append(dict(caseId=file_id,pairId=f'P{i+1:02d}',variant='flawed' if flawed else 'clean',
            path=str(path.relative_to(out)),useContext=CASES[i]['context'],layout=CASES[i]['layout'],
            pageCount=len(pages),sha256=hashlib.sha256(path.read_bytes()).hexdigest(),
            expectedDefects=defects,cleanOnlyText=allowed,
            pages=[dict(page=n,width=p.width,height=p.height,operations=p.facts) for n,p in enumerate(pages,1)]))
    counts=Counter(d['category'] for c in key['cases'] for d in c['expectedDefects'])
    assert counts==Counter({category:6 for category in CATEGORIES}), counts
    (out/'private-key.json').write_text(json.dumps(key,indent=2)+'\n')
    return key


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output',type=Path)
    parser.add_argument('--seed',type=int,default=20260914)
    args=parser.parse_args()
    result=generate(args.output,args.seed)
    print(f"Generated {len(result['cases'])} documents; keep private-key.json private.")
