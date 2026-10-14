export function Identity({name}:{name:string}){const m=/^(.*) \(([^()]*)\)$/.exec(name||'');return m?<>{m[1]} <small className="identity-nickname">({m[2]})</small></>:<>{name}</>;}
