#!/usr/bin/env python3
"""Synthetic PDF controls. No dependencies. Coordinates are PDF points from bottom left."""
import json
from pathlib import Path
import subprocess
import shutil
import sys

OUT = Path(sys.argv[1]).resolve() if len(sys.argv) == 2 else None
if OUT is None:
    raise SystemExit("Usage: python3 bench/pdf/generate.py OUTPUT_DIRECTORY")
OUT.mkdir(parents=True, exist_ok=False)
COMMAND = 'python3 bench/pdf/generate.py OUTPUT_DIRECTORY'
DEFECTS = [
    {'id': 'D1', 'page': 1, 'description': 'The essential instruction in the bordered banner is clipped after "round up"; the essential ending "to whole packs" disappears.', 'expected_remedy': 'Remove the narrow clipping region and show the full instruction on two readable lines.'},
    {'id': 'D2', 'page': 1, 'description': 'The Packs to order and Order cost labels overlap in the calculation row.', 'expected_remedy': 'Place each label above its own separated answer field.'},
    {'id': 'D3', 'page': 2, 'description': 'The essential delivery fee and budget rule uses 4-point type.', 'expected_remedy': 'Set the rule at 12 points with the same prominence as the other instructions.'},
    {'id': 'D4', 'page': 2, 'description': 'The required three-sentence justification has only an 18-point-high answer box.', 'expected_remedy': 'Provide a lined answer area at least 108 points high for the three sentences.'},
]


def pdf(path, pages):
    objects = [b'<< /Type /Catalog /Pages 2 0 R >>',
               b'<< /Type /Pages /Kids [4 0 R 6 0 R] /Count 2 >>',
               b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
    for index, commands in enumerate(pages):
        stream = ('\n'.join(commands) + '\n').encode('ascii')
        objects.append(f'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents {5 + index * 2} 0 R >>'.encode())
        objects.append(f'<< /Length {len(stream)} >>\nstream\n'.encode() + stream + b'endstream')
    data = bytearray(b'%PDF-1.4\n%\xe2\xe3\xcf\xd3\n')
    offsets = [0]
    for index, obj in enumerate(objects, 1):
        offsets.append(len(data))
        data.extend(f'{index} 0 obj\n'.encode() + obj + b'\nendobj\n')
    xref = len(data)
    data.extend(f'xref\n0 {len(offsets)}\n0000000000 65535 f \n'.encode())
    for offset in offsets[1:]:
        data.extend(f'{offset:010d} 00000 n \n'.encode())
    data.extend(f'trailer\n<< /Size {len(offsets)} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n'.encode())
    path.write_bytes(data)


def worksheet(flawed):
    pages = []
    c = []

    def text(x, y, value, size=12):
        escaped = value.replace('\\', '\\\\').replace('(', '\\(').replace(')', '\\)')
        c.append(f'BT /F1 {size} Tf 1 0 0 1 {x} {y} Tm ({escaped}) Tj ET')

    def box(x, y, w, h):
        c.append(f'{x} {y} {w} {h} re S')

    def line(x, y, end):
        c.append(f'{x} {y} m {end} {y} l S')

    def header(page, subtitle):
        c.append('0.12 G 0.12 g 0.7 w')
        text(48, 745, 'Workshop supply order', 23)
        text(48, 721, subtitle, 13)
        line(48, 705, 564)
        text(48, 32, 'Synthetic practice worksheet | All names and figures are invented.', 9)
        text(523, 32, f'{page} / 2', 9)

    header(1, '1. Calculate the order')
    text(48, 676, 'Name: ________________________    Date: __________________')
    text(48, 643, 'You are buying blank notebooks for a community drawing workshop.')
    text(48, 623, 'There are 23 participants. Each participant needs 2 notebooks.')
    text(48, 603, 'Each pack contains 8 notebooks and costs $12. Buy enough for everyone.')
    box(48, 527, 516, 55)
    if flawed:
        c.append('q 58 533 350 43 re W n')
        text(58, 557, 'Use the pack information above to fill in the fields below; round up to whole packs.')
        c.append('Q')
    else:
        text(58, 557, 'Use the pack information above to fill in the fields below;')
        text(58, 539, 'round up to whole packs.')
    text(48, 492, 'Notebooks needed')
    text(245, 492, 'Packs to order')
    text(272 if flawed else 433, 492, 'Order cost')
    for x in (48, 245, 433):
        box(x, 445, 130, 32)
    text(48, 416, 'Show your multiplication and division here.')
    box(48, 300, 516, 100)
    for y in (322, 346, 370):
        line(60, y, 552)
    text(48, 267, 'Planning sketch, optional', 13)
    text(48, 247, 'Use this blank area to draw packs or group notebooks. Leave it blank if unneeded.', 11)
    box(48, 70, 516, 161)
    pages.append(c)
    c = []
    header(2, '2. Check the budget and explain your choice')
    text(48, 675, 'Bring forward your order cost from page 1: $________________')
    box(48, 602, 516, 47)
    text(58, 621, 'Add a $6 delivery fee. Your total must stay within the $80 budget.', 4 if flawed else 12)
    text(48, 570, 'Order cost + delivery fee = final total: $________________')
    text(48, 533, 'Budget left after the order: $________________')
    text(48, 496, 'Does the order fit the budget? Circle one:     Yes     No')
    text(48, 454, 'Explain your decision in three complete sentences.', 13)
    text(48, 434, 'State how many packs you chose, how many notebooks will be left over,')
    text(48, 416, 'and whether the final total fits the budget. Include your calculations.')
    height = 18 if flawed else 120
    box(48, 394 - height, 516, height)
    if not flawed:
        for y in (298, 322, 346, 370):
            line(60, y, 552)
    text(48, 233, 'Partner check', 13)
    text(48, 212, 'Ask a partner to check your pack count and final total.')
    text(48, 180, 'Partner initials: __________    One correction, if needed: __________________')
    text(48, 121, 'Pause here before discussing your answer with the group.', 11)
    text(48, 101, 'The space below is a deliberate pause area. No written response is required.', 10)
    pages.append(c)
    return pages


def main():
    for tool in ("pdfinfo", "pdftoppm"):
        if not shutil.which(tool):
            raise SystemExit(f"Install Poppler and add {tool} to PATH")
    for variant in ('flawed', 'clean'):
        destination = OUT / f'{variant}.pdf'
        pdf(destination, worksheet(variant == 'flawed'))
        info = subprocess.check_output(['pdfinfo', str(destination)], text=True)
        assert 'Pages:           2' in info, info
        subprocess.run(['pdftoppm', '-scale-to', '1400', '-png', str(destination), str(OUT / variant)], check=True)
        assert all((OUT / f'{variant}-{page}.png').exists() for page in (1, 2))
    (OUT / 'ground-truth.json').write_text(json.dumps({
        'generator_command': COMMAND,
        'flawed_pdf': 'flawed.pdf', 'clean_pdf': 'clean.pdf',
        'defects': DEFECTS,
        'valid_whitespace': [
            {'page': 1, 'description': 'Large optional planning sketch box is intentional handwriting/drawing space.'},
            {'page': 2, 'description': 'Bottom pause area explicitly requires no written response.'}],
        'matching': 'Identical task, values, page sizes and content. Only the four defect layouts differ.',
        'synthetic_answer_key': {'notebooks_needed': 46, 'packs': 6, 'order_cost': 72, 'leftover_notebooks': 2, 'final_total': 78, 'budget_left': 2},
    }, indent=2) + '\n')

    for variant in ('flawed', 'clean'):
        destination = OUT / f'reference-{variant}.pdf'
        pdf(destination, reference(variant == 'flawed'))
        info = subprocess.check_output(['pdfinfo', str(destination)], text=True)
        assert 'Pages:           2' in info, info
        subprocess.run(['pdftoppm', '-scale-to', '1400', '-png', str(destination), str(OUT / f'reference-{variant}')], check=True)
        assert all((OUT / f'reference-{variant}-{page}.png').exists() for page in (1, 2))
    (OUT / 'reference-ground-truth.json').write_text(json.dumps({
        'generator_command': COMMAND,
        'flawed_pdf': 'reference-flawed.pdf', 'clean_pdf': 'reference-clean.pdf',
        'defects': [
            {'id': 'R1', 'page': 1, 'description': 'Required routes are identified only by red and green marks even though the sheet says it will be printed in grayscale. The marks use colors of similar grayscale brightness.', 'expected_remedy': 'Add the route names HOLD and SEND beside the marks so the action survives grayscale printing.'},
            {'id': 'R2', 'page': 2, 'description': 'The continuation table lacks column labels and units even though each page is handed out separately.', 'expected_remedy': 'Repeat the Part, Length (mm), and Mass (g) header on the continuation page.'},
        ],
        'negative_cases': [
            {'page': 1, 'description': 'Ordinary line-end hyphenation in displays preserves the word and meaning.'},
            {'page': 1, 'description': '23-point title, 13-point section headings, 11-point table text, and 9-point footer have distinct roles.'},
            {'page': 2, 'description': 'Lower blank area is explicitly reserved for workshop stamps; it is not missing content or an undersized answer field.'},
        ],
        'matching': 'Same text except redundant route labels and repeated continuation header. Same values, page dimensions, colors and benign layout choices.',
        'intended_use': 'Adults use separately distributed grayscale reference pages to route sample parts and interpret measurements.',
    }, indent=2) + '\n')


def reference(flawed):
    pages = []
    for page in (1, 2):
        c = ['0.12 G 0.12 g 0.7 w']

        def text(x, y, value, size=12):
            escaped = value.replace('\\', '\\\\').replace('(', '\\(').replace(')', '\\)')
            c.append(f'BT /F1 {size} Tf 1 0 0 1 {x} {y} Tm ({escaped}) Tj ET')

        text(48, 745, 'Sample part reference', 23)
        text(48, 717, 'Print in grayscale. Each page is handed out separately.', 12)
        text(48, 32, 'Synthetic workshop reference | Invented parts and measurements.', 9)
        text(523, 32, f'{page} / 2', 9)
        if page == 1:
            text(48, 675, 'Routing instructions', 13)
            text(48, 650, 'Send green-marked parts to the packing desk.')
            text(48, 630, 'Hold red-marked parts at the inspection desk.')
            # Similar grayscale brightness makes color alone an unreliable routing key.
            for y, color, part, route in [(595, '0.8 0 0 rg', 'Part A', 'HOLD'), (568, '0 0.407 0 rg', 'Part B', 'SEND')]:
                c.append(f'q {color} 48 {y - 3} 13 13 re f Q')
                text(75, y, part if flawed else f'{part}   {route}')
            text(48, 521, 'When recording a measurement, copy exactly what the instrument dis-', 11)
            text(48, 505, 'plays. Keep the stated units with every value.', 11)
            text(48, 465, 'Measurements', 13)
            top = 435
        else:
            text(48, 675, 'Measurements, continued', 13)
            top = 640
        if page == 1 or not flawed:
            for x, label in [(48, 'Part'), (245, 'Length (mm)'), (433, 'Mass (g)')]:
                text(x, top, label, 11)
        c.append(f'48 {top - 12} m 564 {top - 12} l S')
        rows = [('A', '120', '45'), ('B', '85', '32')] if page == 1 else [('C', '150', '60'), ('D', '95', '38')]
        for index, row in enumerate(rows):
            for x, value in zip((48, 245, 433), row):
                text(x, top - 38 - index * 30, value, 11)
        if page == 2:
            text(48, 475, 'The blank area below is reserved for workshop stamps.', 11)
            text(48, 455, 'No written response is required on this reference sheet.', 11)
        pages.append(c)
    return pages


if __name__ == '__main__':
    main()
