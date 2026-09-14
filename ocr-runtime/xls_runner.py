import argparse
import datetime as dt
import json
import math
import os
import sys


def safe_value(cell, datemode, xlrd):
    if cell.ctype == xlrd.XL_CELL_DATE:
        value = xlrd.xldate_as_datetime(cell.value, datemode)
        if value.time() == dt.time(0, 0):
            return value.date().isoformat()
        return value.isoformat(sep=" ", timespec="seconds")
    if cell.ctype == xlrd.XL_CELL_NUMBER:
        number = float(cell.value)
        if not math.isfinite(number):
            return str(number)
        return str(int(number)) if number.is_integer() else format(number, ".15g")
    if cell.ctype == xlrd.XL_CELL_BOOLEAN:
        return "TRUE" if cell.value else "FALSE"
    if cell.ctype in (xlrd.XL_CELL_EMPTY, xlrd.XL_CELL_BLANK):
        return ""
    if cell.ctype == xlrd.XL_CELL_ERROR:
        return f"[CELL_ERROR:{xlrd.error_text_from_code.get(cell.value, cell.value)}]"
    return str(cell.value).replace("\r", "").replace("\n", " ")


def main():
    parser = argparse.ArgumentParser(description="Read legacy BIFF .xls without executing VBA/macros.")
    parser.add_argument("--input", required=True)
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--max-cells", type=int, default=500000)
    args = parser.parse_args()
    source = os.path.abspath(args.input)
    if not source.lower().endswith(".xls") or not os.path.isfile(source):
        raise ValueError("Input must be an existing .xls file")
    import xlrd
    book = xlrd.open_workbook(source, on_demand=True, formatting_info=False)
    chunks = []
    sheet_stats = []
    total_cells = 0
    for sheet in book.sheets():
        total_cells += sheet.nrows * sheet.ncols
        if total_cells > max(1, args.max_cells):
            raise ValueError("Legacy XLS exceeds safe cell limit")
        rows = []
        for row_index in range(sheet.nrows):
            cells = [safe_value(sheet.cell(row_index, column), book.datemode, xlrd) for column in range(sheet.ncols)]
            while cells and cells[-1] == "":
                cells.pop()
            if cells:
                rows.append("\t".join(cells))
        chunks.append(f"## {sheet.name}\n" + "\n".join(rows))
        sheet_stats.append({"name": sheet.name, "rows": sheet.nrows, "columns": sheet.ncols})
    payload = {
        "text": "\n\n".join(chunks).strip(),
        "parser": "xlrd-safe-legacy-xls",
        "coverage": {"sheetsParsed": len(sheet_stats), "cellsScanned": total_cells, "sheets": sheet_stats},
        "warnings": ["Legacy XLS formulas are returned as cached values; VBA/macros are never executed."],
    }
    sys.stdout.write(json.dumps(payload, ensure_ascii=False))


if __name__ == "__main__":
    main()
