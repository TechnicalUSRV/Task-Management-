"""Regenerate the English template inventory from explicitly marked application text."""
import ast,json,subprocess
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
keys=json.loads(subprocess.check_output(['node',str(ROOT/'tools/i18n/extract-ui.mjs')],text=True))
for file in (ROOT/'backend').rglob('*.py'):
 if any(s in file.parts for s in ('tests','migrations','__pycache__')) or file.name=='i18n.py':continue
 for node in ast.walk(ast.parse(file.read_text())):
  if isinstance(node,ast.Call) and isinstance(node.func,ast.Name) and node.func.id in ('_message','_bot_message','msg','translate_text') and node.args and isinstance(node.args[0],ast.Constant) and isinstance(node.args[0].value,str):
   keys.setdefault(node.args[0].value,[]).append(str(file.relative_to(ROOT)))
keys={k:sorted(set(v)) for k,v in sorted(keys.items())}
(ROOT/'translations/en.json').write_text(json.dumps({k:k for k in keys},ensure_ascii=False,indent=2)+'\n')
(ROOT/'translations/inventory.json').write_text(json.dumps(keys,ensure_ascii=False,indent=2)+'\n')
print(f'{len(keys)} explicit templates')
