#!/usr/bin/env python3
"""Export continuous-capture GIF companions and review frame sheets. No time acceleration."""
from pathlib import Path
import subprocess,json,hashlib,sys
from PIL import Image,ImageDraw,ImageFont
ROOT=Path(sys.argv[1]).resolve() if len(sys.argv)>1 else sys.exit("Usage: export-readme-continuous.py RECORDING_DIRECTORY")
manifest={'kind':'continuous-native-pointer-candidate','sourceCommit':json.loads((ROOT/'media/en/context.evidence.json').read_text()).get('sourceCommit','unknown'),'recording':'Private Xvfb :192; native X11 pointer + recording-only synchronized halo; ffmpeg x11grab 30fps. No product DOM state altered.','locales':{}}
font=ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',16)
def run(args):
 subprocess.run(args,check=True,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,timeout=100)
def info(p):return {'path':str(p.relative_to(ROOT)),'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()}
for locale in ['en','zh-CN']:
 manifest['locales'][locale]={}
 for scene in ['context','capability','diff']:
  folder=ROOT/('docs' if scene=='save' else 'media')/locale
  video=folder/(scene+'.mp4')
  evidence=json.loads((folder/(scene+'.evidence.json')).read_text())
  duration=float(evidence['probe']['format']['duration'])
  # Complete decode validation, not just a readable MP4 header.
  run(['ffmpeg','-v','error','-i',str(video),'-f','null','-'])
  item={'scene':scene,'duration':duration,'width':1440,'height':900,'fps':30,'mp4':info(video),'verification':evidence['verification'],'evidence':str((folder/(scene+'.evidence.json')).relative_to(ROOT))}
  if scene!='save':
   gif=folder/(scene+'.gif')
   run(['ffmpeg','-v','error','-y','-threads','2','-i',str(video),'-filter_complex_threads','1','-vf','fps=15,scale=1200:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle','-loop','0',str(gif)])
   with Image.open(gif) as g:
    assert g.size==(1200,750) and g.info.get('loop')==0
    frames=g.n_frames;total=0
    for n in range(frames):g.seek(n);total+=g.info.get('duration',0);g.convert('RGB').load()
    assert abs(total/1000-duration)<.2,(total,duration)
   item['gif']={**info(gif),'frames':frames,'duration':total/1000,'nominalFps':15,'width':1200,'height':750}
  # Actual video frame posters include the native cursor, unlike browser screenshots.
  poster=folder/(scene+'-poster.jpg');run(['ffmpeg','-v','error','-y','-ss','1','-i',str(video),'-frames:v','1','-q:v','2',str(poster)]);item['poster']=info(poster)
  sheet=Image.new('RGB',(1440,990),'#17211f');draw=ImageDraw.Draw(sheet)
  times=[duration*n/9 for n in range(9)]
  for n,t in enumerate(times):
   frame=folder/(scene+f'-sample-{n}.jpg')
   run(['ffmpeg','-v','error','-y','-ss',str(round(t,3)),'-i',str(video),'-frames:v','1','-q:v','2',str(frame)])
   im=Image.open(frame).convert('RGB').resize((480,300),Image.Resampling.LANCZOS)
   x=(n%3)*480;y=(n//3)*330;sheet.paste(im,(x,y));draw.text((x+8,y+305),f'{locale} / {scene} / {t:.1f}s',font=font,fill='#dce8e4')
  sheetpath=folder/(scene+'-contact.jpg');sheet.save(sheetpath,quality=92);item['contactSheet']=info(sheetpath)
  manifest['locales'][locale][scene]=item
  print(locale,scene,round(duration,2),'s',video.stat().st_size,'MP4 bytes',item.get('gif',{}).get('bytes'),'GIF bytes',flush=True)
(ROOT/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
