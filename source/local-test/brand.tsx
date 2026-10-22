import { uiText, useLanguage } from "./i18n";
import icon from './brand/task-controlling-icon.svg';
import wordmark from './brand/task-controlling-logo.png';
export const LOGO_ALT = 'Task Controlling Management';
// The application title keeps its V5.7.3 typography, independent of icon sizing.
export function BrandTitle() {
  useLanguage();
 return <><span style={{font:'inherit',color:'#037749'}}>{uiText("Task Controlling")}</span>{' '}<span style={{font:'inherit',color:'#bd890b'}}>{uiText("Management")}</span></>;
}
export function LogoIcon({size=40,className='',alt=LOGO_ALT}:{size?:number;className?:string;alt?:string}) {
  useLanguage();
 const width=Math.round(size*1.15),height=Math.round(width*429/450);
 return <img className={`usrv-logo ${className}`} src={icon} width={width} height={height} alt={alt} style={{objectFit:'contain',flexShrink:0,maxWidth:'100%',height:'auto'}} decoding="async" draggable={false}/>;
}
// Render the complete supplied PNG so artwork, typography and spacing scale together.
export function Logo({size=320,className='',alt=LOGO_ALT}:{size?:number;className?:string;alt?:string}) {
  useLanguage();
 return <img className={`usrv-logo ${className}`} src={wordmark} width={size} height={Math.round(size*682/2048)} alt={alt} style={{display:'block',maxWidth:'100%',height:'auto',objectFit:'contain'}} decoding="async" draggable={false}/>;
}
