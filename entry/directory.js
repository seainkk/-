// Bundled into the first Pages document. Only the Firebase project identifier is public configuration.
window.RegistryDirectoryReader = (() => {
  const encoder = new TextEncoder();
  const type = 'outreach-center/firebase-directory/v1';
  const maxAge = 600000;
  async function read(firebase, accessKey, project, signal) {
    if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(firebase) || !/^[\w-]{43}$/.test(accessKey) || !['numshield','neosender'].includes(project)) return {};
    const subtle = window.crypto.subtle;
    const key = await subtle.importKey('raw',encoder.encode(accessKey),'HKDF',false,['deriveBits']);
    const bits = await subtle.deriveBits({name:'HKDF',hash:'SHA-256',salt:encoder.encode(type),info:encoder.encode(firebase)},key,256);
    const capability = btoa(String.fromCharCode(...new Uint8Array(bits))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
    const db = 'projects/'+firebase+'/databases/(default)/documents', base = db+'/directoryViews/'+capability+'/lists/';
    const kinds = new Map([[base+'catalog','sources'],[base+'segments-'+project,'segments']]);
    const response = await window.fetch('https://firestore.googleapis.com/v1/'+db+':batchGet',{
      method:'POST',headers:{'Content-Type':'text/plain;charset=UTF-8'},body:JSON.stringify({documents:[...kinds.keys()]}),
      credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',redirect:'error',signal
    });
    if (!response.ok) return {};
    const body = await response.text();
    if (body.length>3000000) return {};
    const batch = JSON.parse(body);
    if (!Array.isArray(batch) || batch.length>2) return {};
    const result = {}, seen = new Set(), now = Date.now();
    for (const record of batch) {
      const kind = kinds.get(record?.found?.name || record?.missing);
      if (!kind || seen.has(kind)) return {};
      seen.add(kind);
      if (!record.found) continue;
      const fields = record.found.fields;
      if (String(fields?.schema?.integerValue)!=='1' || typeof fields.rowsJson?.stringValue!=='string') continue;
      const checkedAt=Date.parse(fields.generatedAt?.timestampValue), expiresAt=Date.parse(fields.expiresAt?.timestampValue);
      if (!Number.isFinite(checkedAt)||!Number.isFinite(expiresAt)||checkedAt>now+60000||expiresAt<=now||expiresAt<=checkedAt||expiresAt-checkedAt>maxAge+1000) continue;
      const raw=fields.rowsJson.stringValue;
      if (raw.length>850000 || encoder.encode(raw).length>850000) continue;
      let rows;
      try { rows=JSON.parse(raw); } catch { continue; }
      if (!Array.isArray(rows)||rows.length>(kind==='sources'?5000:500)) continue;
      const ids=new Set(),items=[];
      for (const row of rows) {
        if (!row||typeof row.id!=='string'||!/^[\w-]{10,200}$/.test(row.id)||ids.has(row.id)||typeof row.name!=='string'||!row.name.trim()||row.name.length>255) break;
        const item={id:row.id,name:row.name};
        if (kind==='segments') {
          if (row.project!==project||!['clients','partners'].includes(row.section)) break;
          item.category=row.section;
        }
        items.push(item);ids.add(row.id);
      }
      if (items.length===rows.length) result[kind]={kind,checkedAt,expiresAt,complete:true,items};
    }
    return result;
  }
  return {read};
})();
