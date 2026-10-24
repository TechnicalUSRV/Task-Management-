"""Build full catalogs from reviewed bilingual phrases and bounded label patterns.

This is a development-time helper, never an automatic translator of employee data.
Unknown sentences remain explicit gaps; they are not assembled word by word.
"""
from pathlib import Path
from functools import lru_cache
from collections import Counter
import json,re
ROOT=Path(__file__).resolve().parents[2]; WORK=ROOT/'translations/work'
terms={}
def norm(s):return re.sub(r'\s+',' ',s.strip()).casefold()
labels=json.loads((WORK/'short-labels.json').read_text())
for p in sorted(WORK.glob('*.tsv')):
 for line in p.read_text().splitlines():
  if not line or line.startswith('#'):continue
  parts=line.split('\t')
  if len(parts)!=3:raise ValueError((p,line))
  # TSV cells can contain escaped newlines for multi-paragraph bot messages.
  source,km,zh=(cell.replace(r"\n", "\n") for cell in parts)
  if source.isdigit():source=labels[int(source)]
  terms[norm(source)]=(km,zh)
# Immutable brand/product names used in interface text.
for brand in ('Telegram','PDF','CSV','Excel','Google','Google Sheets','Google Drive','Task Controlling Management','H:MM','UTC','CRM','API','URL','ID','A/F','AR','AP'):
 terms.setdefault(norm(brand),(brand,brand))
verbs=['Add','Create','Edit','Delete','Remove','Save','Update','Open','Close','Cancel','Approve','Reject','Accept','Decline','Withdraw','Submit','Return','Review','Request','Reopen','Archive','Restore','Enable','Disable','Hide','Show','Expand','Collapse','Connect','Disconnect','Link','Unlink','Share','Send','Download','Upload','Import','Export','Merge','Split','Select','Choose','Search','Filter','Clear','Reset','Copy','Paste','Duplicate','Manage','View','Check','Configure','Change','Enter','Set','Log']
# Safe whole-label grammar, with explicit word order for Khmer and Chinese.
adjectives={
 'new':('ថ្មី','新'), 'current':('បច្ចុប្បន្ន','当前'), 'selected':('ដែលបានជ្រើស','已选'),
 'saved':('ដែលបានរក្សាទុក','已保存'), 'deleted':('ដែលបានលុប','已删除'), 'pending':('កំពុងរង់ចាំ','待处理'),
 'active':('សកម្ម','有效'), 'inactive':('អសកម្ម','停用'), 'completed':('បានបញ្ចប់','已完成'),
 'cancelled':('បានបោះបង់','已取消'), 'public':('សាធារណៈ','公开'), 'personal':('ផ្ទាល់ខ្លួន','个人'),
 'private':('ឯកជន','私有'), 'shared':('ចែករំលែក','共享'), 'related':('ពាក់ព័ន្ធ','相关'),
 'custom':('ផ្ទាល់ខ្លួន','自定义'), 'default':('លំនាំដើម','默认'), 'available':('ដែលអាចប្រើបាន','可用'),
 'required':('ដែលត្រូវការ','必需'), 'optional':('មិនចាំបាច់','可选'), 'approved':('បានអនុម័ត','已批准'),
 'rejected':('បានបដិសេធ','已拒绝'), 'linked':('បានភ្ជាប់','已关联'), 'open':('មិនទាន់បញ្ចប់','未完成'),
 'closed':('បានបិទ','已关闭'), 'monthly':('ប្រចាំខែ','每月'), 'daily':('ប្រចាំថ្ងៃ','每日'),
 'weekly':('ប្រចាំសប្តាហ៍','每周'), 'other':('ផ្សេងទៀត','其他'), 'additional':('បន្ថែម','额外'),
}
@lru_cache(maxsize=None)
def translate(source,depth=0):
 if depth>8:return None
 s=norm(source)
 if s in terms:return terms[s]
 def tr(x):return translate(x,depth+1)
 # Whitespace/punctuation/emoji are decoration, not vocabulary.
 m=re.fullmatch(r'([^a-z0-9{]*)([a-z0-9{].*?)([ .…?!:·]+)',s)
 if m and (a:=tr(m[2])):return (m[1]+a[0]+m[3],m[1]+a[1]+m[3])
 m=re.fullmatch(r'([^a-z0-9{]+)([a-z0-9{].*)',s)
 if m and (a:=tr(m[2])):return (m[1]+a[0],m[1]+a[1])
 if s.startswith('(') and s.endswith(')') and (a:=tr(s[1:-1])):return ('('+a[0]+')','（'+a[1]+'）')
 m=re.fullmatch(r'(.+) \((optional|required|h:mm|utc)\)',s)
 if m and (a:=tr(m[1])) and (b:=tr(m[2])):return(a[0]+' ('+b[0]+')',a[1]+'（'+b[1]+'）')
 for sep in (' · ',' / ',' & ',' and '):
  parts=s.split(sep)
  if len(parts)>1 and all((p:=tr(x)) for x in parts):
   pairs=[tr(x) for x in parts];return((' និង ' if sep==' and ' else sep).join(p[0] for p in pairs),('与' if sep in (' and ',' & ') else sep).join(p[1] for p in pairs))
 m=re.fullmatch(r'(.+?): (\{p\d+\})',s)
 if m and (a:=tr(m[1])):return(a[0]+'៖ '+m[2],a[1]+'：'+m[2])
 for v in verbs:
  prefix=v.lower()+' '
  if s.startswith(prefix) and (verb:=tr(v)):
   rest=re.sub(r'^(?:a|an|the|this|these) ', '',s[len(prefix):])
   if (a:=tr(rest)):return(verb[0]+' '+a[0],verb[1]+a[1])
 for adjective,words in adjectives.items():
  if s.startswith(adjective+' ') and (a:=tr(s[len(adjective)+1:])):return(a[0]+words[0],words[1]+a[1])
 for prefix,suffix,zh in [('all ','ទាំងអស់','全部'),('my ','របស់ខ្ញុំ','我的'),('your ','របស់អ្នក','你的'),('own ','ផ្ទាល់ខ្លួន','自己的')]:
  if s.startswith(prefix) and (a:=tr(s[len(prefix):])):return(a[0]+suffix,zh+a[1])
 for prefix,km,zh in [('no ','គ្មាន','暂无'),('without ','គ្មាន','不含'),('with ','មាន','含'),('more ','បន្ថែម','更多')]:
  if s.startswith(prefix) and (a:=tr(s[len(prefix):])):return(km+a[0],zh+a[1])
 m=re.fullmatch(r'no (.+) yet',s)
 if m and (a:=tr(m[1])):return('មិនទាន់មាន'+a[0],'尚无'+a[1])
 for ending,km,zh in [(' saved','បានរក្សាទុក','已保存'),(' updated','បានធ្វើបច្ចុប្បន្នភាព','已更新'),(' created','បានបង្កើត','已创建'),(' deleted','បានលុប','已删除'),(' removed','បានដកចេញ','已移除'),(' added','បានបន្ថែម','已添加'),(' changed','បានផ្លាស់ប្តូរ','已更改'),(' cancelled','បានបោះបង់','已取消'),(' approved','បានអនុម័ត','已批准'),(' rejected','បានបដិសេធ','已拒绝'),(' withdrawn','បានដកសំណើ','已撤回'),(' confirmed','បានបញ្ជាក់','已确认'),(' queued','បានដាក់ជួររង់ចាំ','已排队'),(' failed','បរាជ័យ','失败'),(' not found','រកមិនឃើញ','不存在'),(' not available','មិនអាចប្រើបាន','不可用'),(' required','ត្រូវការ','必填')]:
  if s.endswith(ending) and (a:=tr(s[:-len(ending)])):return(km+' '+a[0],a[1]+zh)
 for suffix in ('name','code','id','date','status','type','description','details','settings','permissions','access','history','options','report','summary','filter','search','number','amount','total','title','version'):
  if s.endswith(' '+suffix) and (a:=tr(s[:-len(suffix)-1])) and (b:=tr(suffix)):return(b[0]+a[0],a[1]+b[1])
 m=re.fullmatch(r'(.+) only',s)
 if m and (a:=tr(m[1])):return('តែ'+a[0]+'ប៉ុណ្ណោះ','仅'+a[1])
 if s.endswith('s') and (a:=terms.get(s[:-1])):return a
 return None
keys=json.loads((ROOT/'translations/en.json').read_text())
output={'km':{},'zh-CN':{}};missing=[]
for key in keys:
 value=translate(key)
 if not value:missing.append(key);continue
 source_placeholders=Counter(re.findall(r'\{\w+\}',key))
 if any(Counter(re.findall(r'\{\w+\}',x))!=source_placeholders for x in value):missing.append(key);continue
 lead=re.match(r'^\s*',key)[0];tail=re.search(r'\s*$',key)[0]
 for i,locale in enumerate(output):output[locale][key]=lead+value[i].strip()+tail
for locale,data in output.items():(ROOT/'translations'/f'{locale}.json').write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n')
(ROOT/'translations/work/remaining.json').write_text(json.dumps(missing,ensure_ascii=False,indent=2)+'\n')
print(f'{len(output["km"])} translated templates; {len(missing)} pending (English fallback).')
