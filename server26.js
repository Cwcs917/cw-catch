import express from 'express';
import { startMailAgent, testMailAgent, getPending, deletePending, listPending } from './mail-agent.js';
import fetch from 'node-fetch';
import path from 'path';
import { fileURLToPath } from 'url';
import { PDFDocument } from 'pdf-lib';
import SftpClient from 'ssh2-sftp-client';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// ─── SFTP konfiguration ───────────────────────────────────────────────────────
const SFTP_CONFIG = {
  host: '137.184.5.138',
  port: 22,
  username: 'emmasftp',
  password: 'CWspedition2026!'
};

async function uploadToSftp(xmlContent, filename, module) {
  const sftp = new SftpClient();
  const folder = (module === 'NO') ? '/no' : '/dk';
  const remotePath = folder + '/' + filename;
  try {
    await sftp.connect(SFTP_CONFIG);
    await sftp.mkdir(folder, true); // opret mappe hvis den ikke findes
    const buf = Buffer.from(xmlContent, 'utf8');
    await sftp.put(buf, remotePath);
    console.log('SFTP uploaded: ' + remotePath);
    await sftp.end();
    return true;
  } catch(err) {
    console.error('SFTP fejl:', err.message);
    try { await sftp.end(); } catch(e) {}
    return false;
  }
}
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(__dirname));

// ─── Claude API ───────────────────────────────────────────────────────────────
// Model — kan overrides med CLAUDE_MODEL env variabel
const ACTIVE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-5-20250929';

async function callClaude(apiKey, b64, prompt, maxTokens) {
  const model = ACTIVE_MODEL;
  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01'
  };
  console.log('callClaude model:', model);

  const MAX_RETRIES = 3;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model, max_tokens: maxTokens,
        temperature: 0,  // Deterministisk output — samme PDF skal give samme udtræk hver gang
        messages: [{ role: 'user', content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } },
          { type: 'text', text: prompt }
        ]}]
      })
    });
    const data = await response.json();
    if (data.error) {
      const errType = data.error.type || '';
      if ((errType === 'overloaded_error' || errType === 'rate_limit_error') && attempt < MAX_RETRIES) {
        const wait = attempt * 8000; // 8s, 16s
        console.log('API overbelastet, venter ' + (wait/1000) + 's (forsøg ' + attempt + '/' + MAX_RETRIES + ')');
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      console.error('Claude API fejl:', JSON.stringify(data.error));
      throw new Error(data.error.message || JSON.stringify(data.error));
    }
    if (!data.content) {
      console.error('Uventet API svar:', JSON.stringify(data).substring(0, 300));
      throw new Error('Uventet API svar: ' + JSON.stringify(data).substring(0, 200));
    }
    return data.content.map(c => c.text || '').join('');
  }
}

// ─── XML hjælpefunktioner ─────────────────────────────────────────────────────
function xmlEsc(s) {
  return (s || '').replace(/[&<>\u0080-\uFFFF]/g, function(c) {
    if (c === '&') return '&amp;';
    if (c === '<') return '&lt;';
    if (c === '>') return '&gt;';
    return '&#' + c.charCodeAt(0) + ';';
  });
}
function trunc35(s) { return (s || '').replace(/[\r\n]+/g, ' ').trim().substring(0, 35); }
function normCOO(coo) {
  if (!coo) return 'XX';
  const c = coo.trim().toUpperCase().replace(/[^A-Z]/g,'');
  // Map ikke-standard landekoder til ISO 2-bogstavs
  const map = {
    'D':'DE','H':'HU','I':'IT','F':'FR','E':'ES','N':'NO','S':'SE',
    'A':'AT','B':'BE','NL':'NL','PL':'PL','CZ':'CZ','SK':'SK',
    'IND':'IN','IND.':'IN','VRC':'CN','CHN':'CN','ROC':'TW',
    'USA':'US','GBR':'GB','FRA':'FR','DEU':'DE','AUT':'AT',
    'BEL':'BE','NLD':'NL','POL':'PL','ITA':'IT','ESP':'ES',
    'SWE':'SE','DNK':'DK','NOR':'NO','FIN':'FI',
    'TUR':'TR','ISR':'IL','TWN':'TW','KOR':'KR','JPN':'JP',
    'BGD':'BD','PAK':'PK','VNM':'VN','THA':'TH','MYS':'MY',
    'IDN':'ID','PHL':'PH','LKA':'LK','MEX':'MX','BRA':'BR',
    'ARG':'AR','CHL':'CL','COL':'CO','PER':'PE',
    'MAR':'MA','EGY':'EG','ZAF':'ZA','NGA':'NG','KEN':'KE',
    'EU':'DE','EG':'EG',
  };
  if (map[c]) return map[c];
  // Hvis allerede 2 bogstaver og gyldigt — brug det
  if (c.length === 2) return c;
  // Ellers XX
  return 'XX';
}
function n(s) { return xmlEsc(trunc35((s||''))); }
function sanitizeRef(s) {
  // Renser en sagsreference så den kan bruges som filnavn på Windows og Linux.
  // File System Access API afviser også \ / : * ? " < > | og leading dots.
  let f = String(s || '').trim();
  if (!f) return 'tolddata';
  f = f.replace(/[\\/:*?"<>|]/g, '_')   // forbudte tegn → _
       .replace(/^\.+/, '')              // leading punktum væk
       .replace(/[. ]+$/, '')            // trailing punktum/space væk
       .replace(/\s+/g, '_');            // whitespace → _
  return f || 'tolddata';
}

function normPostalCode(s) {
  // Emma kræver max 9 tegn. To problematiske formater:
  //   1) US ZIP+4: "14341-6732" → tag delen før bindestreg ("14341")
  //   2) EU med landekode-præfiks: "SE-114 56", "DE-12345" → strip præfikset ("114 56", "12345")
  // Reglen: hvis bindestreg findes og venstre del KUN er bogstaver, brug højre del.
  //         ellers brug venstre del. Til sidst trim til 9 tegn.
  if (!s) return '';
  let p = String(s).trim();
  if (p.includes('-')) {
    const [left, right] = p.split('-', 2).map(x => x.trim());
    if (/^[A-Za-z]+$/.test(left) && right) {
      p = right; // "SE-114 56" → "114 56"
    } else {
      p = left;  // "14341-6732" → "14341"
    }
  }
  return p.substring(0, 9);
}
function normBeloeb(s) {
  if (!s) return '0';
  s = String(s).trim();
  if (s.lastIndexOf(',') > s.lastIndexOf('.')) return s.replace(/\./g, '').replace(',', '.');
  return s.replace(/,/g, '');
}

// Beregner brutto+netto pr. varelinje — bruges af alle XML-buildere og deles via JSON.
// Logik:
//   1. Hvis varelinjen har egen brutto i PDF, brug den. Resten af bv-totalen fordeles
//      blandt linjer uden egen brutto, primært efter nettovægt-andel hvis det findes,
//      ellers efter beløb-andel.
//   2. Linjens nettovægt: hvis PDF angav nettovægt for linjen, brug den.
//      Ellers beregn nv = bv * (nvTot/bvTot).
// Returns: array af {bv, nv} parallelt med varelinjer.
function beregnVarelinjeVægte(varelinjer, bvTot, nvTot) {
  const ratio = (bvTot > 0 && nvTot > 0 && bvTot !== nvTot) ? (nvTot / bvTot) : 1;
  // Find PDF-værdier pr. linje (null hvis ikke angivet)
  const egenBrt = varelinjer.map(function(v) {
    const b = parseFloat(normBeloeb(v.bruttovægt || '0')) || 0;
    return b > 0 ? b : null;
  });
  const egenNet = varelinjer.map(function(v) {
    const n = parseFloat(normBeloeb(v.nettovægt || '0')) || 0;
    return n > 0 ? n : null;
  });

  // ── FAIL-SAFE: Koncentreret vægt på få linjer ──
  // Diana Lys/Jemaplast-mønstret: vægten står inde i ÉN linjes beskrivelse
  // (typisk paller eller første varelinje) som "2557kg. Brutto, 2440kg. Netto"
  // — det er fakturaens TOTAL men Claude tolker det som linjens egen vægt.
  // Detektor: kun 1 linje har egen vægt, mens 2+ andre har 0, og den ene linjes
  // vægt udgør 95%+ af total. Da er det total der står fejlplaceret på den ene linje.
  if (bvTot > 0 && varelinjer.length >= 3) {
    const linjerMedBrt = egenBrt.filter(b => b !== null).length;
    const linjerUden = egenBrt.length - linjerMedBrt;
    const pdfBrtSum = egenBrt.reduce((s, b) => s + (b || 0), 0);
    if (linjerMedBrt >= 1 && linjerUden >= 2 * linjerMedBrt && pdfBrtSum >= bvTot * 0.95) {
      console.log('[beregnVarelinjeVægte] Koncentreret brutto detekteret (' + linjerMedBrt + ' af ' + varelinjer.length + ' linjer har ' + pdfBrtSum.toFixed(0) + 'kg af ' + bvTot.toFixed(0) + 'kg total). Nulstiller pr-linje brutto så fordeling sker fra header.');
      for (let i = 0; i < egenBrt.length; i++) egenBrt[i] = null;
    }
  }
  if (nvTot > 0 && varelinjer.length >= 3) {
    const linjerMedNet = egenNet.filter(n => n !== null).length;
    const linjerUden = egenNet.length - linjerMedNet;
    const pdfNetSum = egenNet.reduce((s, n) => s + (n || 0), 0);
    if (linjerMedNet >= 1 && linjerUden >= 2 * linjerMedNet && pdfNetSum >= nvTot * 0.95) {
      console.log('[beregnVarelinjeVægte] Koncentreret netto detekteret (' + linjerMedNet + ' af ' + varelinjer.length + ' linjer har ' + pdfNetSum.toFixed(0) + 'kg af ' + nvTot.toFixed(0) + 'kg total). Nulstiller pr-linje netto så fordeling sker fra header.');
      for (let i = 0; i < egenNet.length; i++) egenNet[i] = null;
    }
  }

  const pdfBrtSum = egenBrt.reduce(function(s, b) { return s + (b || 0); }, 0);
  const restBrt = Math.max(0, bvTot - pdfBrtSum);

  // Til fordeling af restBrt: brug nettovægt-andel hvis muligt, ellers beløb-andel
  const restNetSum = varelinjer.reduce(function(s, v, i) {
    if (egenBrt[i] !== null) return s;
    return s + (egenNet[i] || 0);
  }, 0);
  const restBeloebSum = varelinjer.reduce(function(s, v, i) {
    if (egenBrt[i] !== null) return s;
    return s + (parseFloat(normBeloeb(v.beloeb))||0);
  }, 0);
  const brugNetTilFordeling = restNetSum > 0;

  // Ingen total angivet — fald tilbage til linjens egne tal
  if (bvTot <= 0) {
    return varelinjer.map(function(v, i) {
      const bv = egenBrt[i] || egenNet[i] || 0;
      const nv = egenNet[i] !== null ? egenNet[i]
               : (ratio !== 1 ? Math.round(bv * ratio * 1000) / 1000 : bv);
      return { bv: bv, nv: nv };
    });
  }

  // Find sidste linje uden egen brutto — den absorberer afrundings-rest
  let sidsteFordeltIdx = -1;
  for (let i = varelinjer.length - 1; i >= 0; i--) {
    if (egenBrt[i] === null) { sidsteFordeltIdx = i; break; }
  }
  let fordeltSofar = 0;
  return varelinjer.map(function(v, i) {
    let bv;
    if (egenBrt[i] !== null) {
      bv = egenBrt[i];
    } else if (i === sidsteFordeltIdx) {
      bv = Math.round((restBrt - fordeltSofar) * 1000) / 1000;
    } else if (brugNetTilFordeling && restNetSum > 0) {
      const andel = (egenNet[i] || 0) / restNetSum;
      bv = Math.round(restBrt * andel * 1000) / 1000;
      fordeltSofar += bv;
    } else if (restBeloebSum > 0) {
      const andel = (parseFloat(normBeloeb(v.beloeb))||0) / restBeloebSum;
      bv = Math.round(restBrt * andel * 1000) / 1000;
      fordeltSofar += bv;
    } else {
      bv = 0;
    }
    // Nettovægt: brug PDF's egen hvis angivet, ellers beregn fra ratio
    let nv;
    if (egenNet[i] !== null && egenBrt[i] === null) {
      // Linjen har kun netto — brug den direkte
      nv = egenNet[i];
    } else {
      nv = (ratio !== 1) ? Math.round(bv * ratio * 1000) / 1000 : bv;
    }
    return { bv: bv, nv: nv };
  });
}
function formatTIN(t, land) {
  if (!t) return '';
  // Strip MVA, VAT, CVR suffikser og specialtegn
  let d = t.replace(/[^A-Za-z0-9]/g, '');
  d = d.replace(/MVA$/i, '').replace(/VAT$/i, '').replace(/CVR$/i, '');
  if (/^[A-Z]{2}/i.test(d)) return d.toUpperCase();
  return (land || 'DK').toUpperCase().substring(0, 2) + d;
}
function formatDato(dato, fallback) {
  if (!dato) return fallback;
  // 04-NOV-2025 eller 04-Nov-2025
  const maaneder = {JAN:'01',FEB:'02',MAR:'03',APR:'04',MAY:'05',MAJ:'05',JUN:'06',
                    JUL:'07',AUG:'08',SEP:'09',OCT:'10',OKT:'10',NOV:'11',DEC:'12'};
  const mMatch = dato.match(/^(\d{2})-([A-Za-z]{3})-(\d{4})$/);
  if (mMatch) {
    const m = maaneder[(mMatch[2]).toUpperCase()];
    if (m) return mMatch[3]+'-'+m+'-'+mMatch[1];
  }
  // 12-03-26 (dd-mm-yy)
  if (/^\d{2}-\d{2}-\d{2}$/.test(dato)) { const [d,m,y]=dato.split('-'); return '20'+y+'-'+m+'-'+d; }
  // 02.08.2023 (dd.mm.yyyy)
  if (/^\d{2}\.\d{2}\.\d{4}$/.test(dato)) { const [d,m,y]=dato.split('.'); return y+'-'+m+'-'+d; }
  // 02.08.23 (dd.mm.yy)
  if (/^\d{2}\.\d{2}\.\d{2}$/.test(dato)) { const [d,m,y]=dato.split('.'); return '20'+y+'-'+m+'-'+d; }
  // 2025-11-04 eller 2025-11-04T... — strip timestamp
  if (/^\d{4}-\d{2}-\d{2}/.test(dato)) return dato.substring(0,10);
  return fallback;
}

// ─── Emma XML bygger ──────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════
// NO_EX — Norsk eksport (Toplogistik-format)
// Separat fra buildEmmaXML fordi formatet er fundamentalt anderledes:
//  - MessageType=DFU (samme som al NO Import/Export — altid DFU)
//  - <Integration>Default</Integration>
//  - DispatchCountry=NO (ikke DK)
//  - CustomsCode udfyldt (fx 3770 for Svinesund svensk side)
//  - Bruger <LongDescription> i stedet for <Description>
//  - Ingen <Goodsnumber>
//  - Tilføjer <Waybill> blok med ordregiver/klientnummer
//  - Ingen <CustomsApproval> (Emma udfylder selv ved godkendelse)
// ═══════════════════════════════════════════════════════════════════════════
function buildEmmaXML_NO_EX(data, transport) {
  const h = data.header || {};
  const fakturaer = data.fakturaer || [];
  const varelinjer = data.varelinjer || [];

  function g(field) { return (h[field] && h[field].value) ? h[field].value.trim() : ''; }

  const ref       = g('Afregningsreference') || 'REF';
  const afsLand   = xmlEsc(g('Afsender land') || 'NO');
  const modLand   = xmlEsc(g('Modtager land') || 'DE');
  const incoterms = (xmlEsc(g('Incoterms')) || 'FCA').substring(0,3) || 'FCA';
  const kolli     = g('Antal kolli i alt') || '1';
  const bvAlt     = normBeloeb(g('Bruttovægt i alt (kg)') || '0');
  const nvAlt     = normBeloeb(g('Nettovægt i alt (kg)') || '0');

  // Shipper TIN: strip NO-præfix (Toplogistik-eksemplet havde '979373287' uden NO-præfix)
  const afsTinRaw = formatTIN(g('Afsender CVR/VAT'), afsLand);
  const afsTin    = afsTinRaw.replace(/^[A-Za-z]{2}/, '');

  // LRN/eksport-ID — bruges i <LRN>. Hvis ikke angivet, lad vi feltet tomt (Emma sætter)
  const lrn = g('LRN') || '';

  // CustomsCode fra transport (fx 3770 for Svinesund svensk side)
  const customsCode = (transport && transport.customsCode) ? String(transport.customsCode).trim() : '';
  // BorderID = bilnummer, BorderNationality = nationalitet
  const borderId  = (transport && transport.borderId) ? String(transport.borderId).trim() : '';
  const borderNat = (transport && transport.borderNat) ? String(transport.borderNat).trim() : 'PL';

  // Waybill-klient
  const kundenummer = (transport && transport.kundenummer) ? String(transport.kundenummer).trim() : '';
  const kundeNavn   = (transport && transport.kundeNavn) ? String(transport.kundeNavn).trim() : '';

  const today = new Date().toISOString().split('T')[0];
  const ts    = new Date().toISOString();
  const T = '\t', NL = '\r\n';

  const L = [];
  L.push('<?xml version="1.0" encoding="UTF-8"?>');
  L.push('<EmmaCustomsDeclaration>');
  L.push(T+'<ExchangeID>'+xmlEsc(ref)+'/'+Date.now()+'</ExchangeID>');
  L.push(T+'<Integration>Default</Integration>');
  L.push(T+'<Module>NO</Module>');
  L.push(T+'<GeneratedTimestamp>'+ts+'</GeneratedTimestamp>');
  L.push(T+'<Declaration>');
  L.push(T+T+'<ExportDeclaration>');
  L.push(T+T+T+'<Reference>'+xmlEsc(ref)+'</Reference>');
  L.push(T+T+T+'<LRN>'+xmlEsc(lrn)+'</LRN>');
  L.push(T+T+T+'<Procedure>10</Procedure>');
  L.push(T+T+T+'<DeclarationType>EU</DeclarationType>');
  L.push(T+T+T+'<MessageType>DFU</MessageType>');
  L.push(T+T+T+'<TotalNumPackages>'+xmlEsc(kolli)+'</TotalNumPackages>');
  L.push(T+T+T+'<TotalGrossWeight>'+xmlEsc(bvAlt)+'</TotalGrossWeight>');
  L.push(T+T+T+'<TotalNetWeight>'+xmlEsc(nvAlt)+'</TotalNetWeight>');

  // Shipper (norsk afsender)
  L.push(T+T+T+'<Shipper>');
  if (afsTin) L.push(T+T+T+T+'<TIN>'+afsTin+'</TIN>');
  L.push(T+T+T+T+'<Name>'+n(g('Afsender navn'))+'</Name>');
  L.push(T+T+T+T+'<Address>'+n(g('Afsender gade'))+'</Address>');
  if (g('Afsender postnummer')) L.push(T+T+T+T+'<PostalCode>'+xmlEsc(normPostalCode(g('Afsender postnummer')))+'</PostalCode>');
  if (g('Afsender by')) L.push(T+T+T+T+'<City>'+n(g('Afsender by'))+'</City>');
  L.push(T+T+T+T+'<CountryCode>'+afsLand+'</CountryCode>');
  L.push(T+T+T+'</Shipper>');

  // Consignee (EU-modtager)
  L.push(T+T+T+'<Consignee>');
  L.push(T+T+T+T+'<Name>'+n(g('Modtager navn'))+'</Name>');
  L.push(T+T+T+T+'<Address>'+n(g('Modtager gade'))+'</Address>');
  if (g('Modtager postnummer')) L.push(T+T+T+T+'<PostalCode>'+xmlEsc(normPostalCode(g('Modtager postnummer')))+'</PostalCode>');
  if (g('Modtager by')) L.push(T+T+T+T+'<City>'+n(g('Modtager by'))+'</City>');
  L.push(T+T+T+T+'<CountryCode>'+modLand+'</CountryCode>');
  L.push(T+T+T+'</Consignee>');

  L.push(T+T+T+'<DispatchCountry>'+afsLand+'</DispatchCountry>');
  L.push(T+T+T+'<DestinationCountry>'+modLand+'</DestinationCountry>');
  L.push(T+T+T+'<CustomsCode>'+xmlEsc(customsCode)+'</CustomsCode>');

  L.push(T+T+T+'<TermsOfDelivery>');
  L.push(T+T+T+T+'<Code>'+incoterms+'</Code>');
  L.push(T+T+T+T+'<Description>'+n(g('Modtager by')||g('Modtager land'))+'</Description>');
  L.push(T+T+T+'</TermsOfDelivery>');

  L.push(T+T+T+'<FreightLocalCode>X</FreightLocalCode>');
  L.push(T+T+T+'<TransactionCode>01</TransactionCode>');

  // Transport — ingen MethodDomestic for NO_EX
  L.push(T+T+T+'<Transport>');
  if (borderId) L.push(T+T+T+T+'<BorderID>'+xmlEsc(borderId)+'</BorderID>');
  L.push(T+T+T+T+'<BorderNationality>'+xmlEsc(borderNat)+'</BorderNationality>');
  L.push(T+T+T+T+'<Method>30</Method>');
  L.push(T+T+T+'</Transport>');

  // Fakturaer
  L.push(T+T+T+'<Invoices>');
  fakturaer.forEach(function(f) {
    const dato = formatDato(f.fakturadato || f.dato, today);
    const valuta = xmlEsc(f.valuta || 'EUR');
    L.push(T+T+T+T+'<Invoice>');
    L.push(T+T+T+T+T+'<InvoiceNumber>'+xmlEsc(f.fakturanummer||'')+'</InvoiceNumber>');
    L.push(T+T+T+T+T+'<Amount Currency="'+valuta+'">'+normBeloeb(f.beloeb)+'</Amount>');
    L.push(T+T+T+T+T+'<Date>'+dato+'</Date>');
    const exchRateVal = parseFloat((f.vekselkurs || '').replace(',','.')) || 11.21;
    L.push(T+T+T+T+T+'<ExchangeRate>'+exchRateVal+'</ExchangeRate>');
    L.push(T+T+T+T+'</Invoice>');
  });
  L.push(T+T+T+'</Invoices>');

  // Varelinjer — brug LongDescription i stedet for Description
  const bvTotNum = parseFloat(bvAlt) || 0;
  const nvTotNum = parseFloat(nvAlt) || 0;
  const nettoRatio = (bvTotNum > 0 && nvTotNum > 0 && bvTotNum !== nvTotNum) ? (nvTotNum / bvTotNum) : 1;
  const totalBeloeb = varelinjer.reduce(function(sum, v) { return sum + (parseFloat(normBeloeb(v.beloeb))||0); }, 0);
  const vægte = beregnVarelinjeVægte(varelinjer, bvTotNum, nvTotNum);

  L.push(T+T+T+'<Items>');
  varelinjer.forEach(function(v, vIdx) {
    const bv = vægte[vIdx].bv;
    const nv = vægte[vIdx].nv;

    // Statistical-værdi: NOK-konverteret beløb via vekselkurs
    const beloebNum = parseFloat(normBeloeb(v.beloeb)) || 0;
    const faktVekselkurs = parseFloat(((fakturaer[0] && fakturaer[0].vekselkurs) || '').replace(',','.')) || 11.21;
    let stat;
    if (faktVekselkurs > 20) {
      // Kurs per 100 enheder (fx DKK)
      stat = Math.round(beloebNum * faktVekselkurs / 100 * 100) / 100;
    } else {
      // Direkte faktor (EUR/USD osv.)
      stat = Math.round(beloebNum * faktVekselkurs * 100) / 100;
    }

    const totalKolli = parseInt(kolli) || 1;
    // Kolli-fordeling: første varelinje får hele totalen, øvrige linjer får 0
    const pkAntal = (vIdx===0) ? totalKolli : 0;
    const hskode = (v.hs_kode||'').replace(/\D/g,'').substring(0,8);

    L.push(T+T+T+T+'<GoodsItem>');
    L.push(T+T+T+T+T+'<CommodityCode>'+hskode+'</CommodityCode>');
    L.push(T+T+T+T+T+'<Value>'+normBeloeb(v.beloeb)+'</Value>');
    const coo = normCOO(v.coo) === 'XX' ? 'NO' : normCOO(v.coo);
    L.push(T+T+T+T+T+'<Origin>'+coo+'</Origin>');
    L.push(T+T+T+T+T+'<CountyOfOrigin>99</CountyOfOrigin>');
    L.push(T+T+T+T+T+'<GrossWeight>'+bv+'</GrossWeight>');
    L.push(T+T+T+T+T+'<NetWeight>'+nv+'</NetWeight>');
    L.push(T+T+T+T+T+'<Packaging>');
    L.push(T+T+T+T+T+T+'<Packages>');
    L.push(T+T+T+T+T+T+T+'<PackageType>PK</PackageType>');
    L.push(T+T+T+T+T+T+T+'<NumPackages>'+pkAntal+'</NumPackages>');
    L.push(T+T+T+T+T+T+T+'<MarksAndNumber>Addr</MarksAndNumber>');
    L.push(T+T+T+T+T+T+'</Packages>');
    L.push(T+T+T+T+T+'</Packaging>');
    L.push(T+T+T+T+T+'<LongDescription>'+xmlEsc(trunc35(v.beskrivelse))+'</LongDescription>');
    L.push(T+T+T+T+T+'<Procedure>10</Procedure>');
    L.push(T+T+T+T+T+'<PreviousProcedure>00</PreviousProcedure>');
    L.push(T+T+T+T+T+'<Preference>N</Preference>');
    L.push(T+T+T+T+T+'<Values>');
    L.push(T+T+T+T+T+T+'<Additionally Currency="NOK">0</Additionally>');
    L.push(T+T+T+T+T+T+'<Deduction Currency="NOK">0</Deduction>');
    L.push(T+T+T+T+T+T+'<Statistical Currency="NOK">'+stat+'</Statistical>');
    L.push(T+T+T+T+T+'</Values>');
    L.push(T+T+T+T+T+'<ValuationMethod>1</ValuationMethod>');
    L.push(T+T+T+T+'</GoodsItem>');
  });
  L.push(T+T+T+'</Items>');

  // Waybill — ordregiver + aggregeret forsendelse
  // Brug første varelinjes beskrivelse som fælles tekst (samme som Toplogistik-eksemplet)
  const faellesBeskr = (varelinjer[0] && varelinjer[0].beskrivelse) ? trunc35(varelinjer[0].beskrivelse) : '';
  L.push(T+T+T+'<Waybill>');
  L.push(T+T+T+T+'<Client>');
  if (kundenummer) L.push(T+T+T+T+T+'<InternalID>'+xmlEsc(kundenummer)+'</InternalID>');
  L.push(T+T+T+T+T+'<Name>'+n(kundeNavn)+'</Name>');
  L.push(T+T+T+T+'</Client>');
  L.push(T+T+T+T+'<Items>');
  L.push(T+T+T+T+T+'<GrossWeight>'+xmlEsc(bvAlt)+'</GrossWeight>');
  L.push(T+T+T+T+T+'<NetWeight>'+xmlEsc(nvAlt)+'</NetWeight>');
  L.push(T+T+T+T+T+'<Quantity>'+xmlEsc(kolli)+'</Quantity>');
  L.push(T+T+T+T+T+'<MarksAndNumbers>Addr</MarksAndNumbers>');
  L.push(T+T+T+T+T+'<Description>'+xmlEsc(faellesBeskr)+'</Description>');
  L.push(T+T+T+T+'</Items>');
  L.push(T+T+T+'</Waybill>');

  L.push(T+T+'</ExportDeclaration>');
  L.push(T+'</Declaration>');
  L.push('</EmmaCustomsDeclaration>');
  return L.join(NL);
}

function buildEmmaXML(data, module, type, mrn, transport) {
  const h = data.header || {};
  const fakturaer = data.fakturaer || [];
  const varelinjer = data.varelinjer || [];
  const isExport = (type === 'export');
  const mod = (module || 'DK').toUpperCase();
  const isNO = (mod === 'NO');

  // ═══════════════════════════════════════════════════════════
  // NO_EX (Norsk eksport) — helt separat format (Toplogistik etc.)
  // AUBO's NO_IM påvirkes IKKE
  // ═══════════════════════════════════════════════════════════
  if (isNO && isExport) {
    return buildEmmaXML_NO_EX(data, transport);
  }

  function g(field) { return (h[field] && h[field].value) ? h[field].value.trim() : ''; }

  const ref       = g('Afregningsreference') || 'REF';
  const afsLand   = xmlEsc(g('Afsender land') || 'DK');
  const modLand   = xmlEsc(g('Modtager land') || (isNO ? 'NO' : 'DK'));
  const incoterms = (xmlEsc(g('Incoterms')) || 'DAP').substring(0,3) || 'DAP';
  const kolli     = g('Antal kolli i alt') || '1';
  const bvAlt     = normBeloeb(g('Bruttovægt i alt (kg)') || '0');
  const nvAlt     = normBeloeb(g('Nettovægt i alt (kg)') || '0');
  const tin       = formatTIN(g('Modtager CVR/VAT'), modLand);
  // Shipper TIN: BEHOLD landepræfix (DK28854846 osv.)
  const afsTinRaw = formatTIN(g('Afsender CVR/VAT'), afsLand);
  const afsTin    = afsTinRaw; // Aldrig strip prefix fra shipper
  // Consignee TIN: strip NO præfix for NO modul (988440965 ikke NO988440965)
  const tinClean  = isNO ? tin.replace(/^[A-Za-z]{2}/, '') : tin;
  const tollkreditt = g('Tollkreditt');
  const today     = new Date().toISOString().split('T')[0];
  const ts        = new Date().toISOString();
  const T = '\t', NL = '\r\n';

  const L = [];
  L.push('<?xml version="1.0" encoding="UTF-8"?>');
  L.push('<EmmaCustomsDeclaration>');
  L.push(T+'<ExchangeID>'+xmlEsc(ref)+'/'+Date.now()+'</ExchangeID>');
  L.push(T+'<Module>'+mod+'</Module>');
  L.push(T+'<GeneratedTimestamp>'+ts+'</GeneratedTimestamp>');
  L.push(T+'<Declaration>');

  if (isNO) {
    // ═══════════════════════════════════════════════════════════
    // NORSK — Import eller Eksport
    // ═══════════════════════════════════════════════════════════
    L.push(T+T+'<'+(isExport?'ExportDeclaration':'ImportDeclaration')+'>');
    L.push(T+T+T+'<Reference>'+xmlEsc(ref)+'</Reference>');
    L.push(T+T+T+'<LRN></LRN>');
    L.push(T+T+T+'<Procedure>'+(isExport?'10':'40')+'</Procedure>');
    L.push(T+T+T+'<DeclarationType>EU</DeclarationType>');
    L.push(T+T+T+'<MessageType>DFU</MessageType>');
    L.push(T+T+T+'<TotalNumPackages>'+xmlEsc(kolli)+'</TotalNumPackages>');
    L.push(T+T+T+'<TotalGrossWeight>'+xmlEsc(bvAlt)+'</TotalGrossWeight>');
    L.push(T+T+T+'<TotalNetWeight>'+xmlEsc(nvAlt)+'</TotalNetWeight>');

    // Shipper
    L.push(T+T+T+'<Shipper>');
    if (afsTin) L.push(T+T+T+T+'<TIN>'+afsTin+'</TIN>');
    L.push(T+T+T+T+'<Name>'+n(g('Afsender navn'))+'</Name>');
    L.push(T+T+T+T+'<Address>'+n(g('Afsender gade'))+'</Address>');
    if (g('Afsender postnummer')) L.push(T+T+T+T+'<PostalCode>'+xmlEsc(normPostalCode(g('Afsender postnummer')))+'</PostalCode>');
    if (g('Afsender by')) L.push(T+T+T+T+'<City>'+n(g('Afsender by'))+'</City>');
    L.push(T+T+T+T+'<CountryCode>'+afsLand+'</CountryCode>');
    L.push(T+T+T+'</Shipper>');

    // Consignee
    L.push(T+T+T+'<Consignee>');
    if (tinClean) L.push(T+T+T+T+'<TIN>'+tinClean+'</TIN>');
    L.push(T+T+T+T+'<Name>'+n(g('Modtager navn'))+'</Name>');
    L.push(T+T+T+T+'<Address>'+n(g('Modtager gade'))+'</Address>');
    if (g('Modtager postnummer')) L.push(T+T+T+T+'<PostalCode>'+xmlEsc(normPostalCode(g('Modtager postnummer')))+'</PostalCode>');
    if (g('Modtager by')) L.push(T+T+T+T+'<City>'+n(g('Modtager by'))+'</City>');
    L.push(T+T+T+T+'<CountryCode>'+modLand+'</CountryCode>');
    L.push(T+T+T+'</Consignee>');

    if (isExport) {
      L.push(T+T+T+'<DestinationCountry>'+modLand+'</DestinationCountry>');
      L.push(T+T+T+'<CustomsCode></CustomsCode>');
    } else {
      L.push(T+T+T+'<DispatchCountry>'+afsLand+'</DispatchCountry>');
      // Norsk grænse-toldsted (hvor varerne ankommer) - fra UI-dropdown
      const noImCustomsCode = (transport && transport.customsCode) ? String(transport.customsCode).trim() : '';
      if (noImCustomsCode) {
        L.push(T+T+T+'<CustomsCode>'+xmlEsc(noImCustomsCode)+'</CustomsCode>');
      }
      // Tollkreditt (kun hvis angivet)
      if (tollkreditt) {
        L.push(T+T+T+'<CustomsAccount>');
        L.push(T+T+T+T+'<Type>M</Type>');
        L.push(T+T+T+T+'<Description>Tollkreditt</Description>');
        L.push(T+T+T+T+'<Account>'+xmlEsc(tollkreditt)+'</Account>');
        L.push(T+T+T+'</CustomsAccount>');
      }
    }

    L.push(T+T+T+'<TermsOfDelivery>');
    L.push(T+T+T+T+'<Code>'+incoterms+'</Code>');
    L.push(T+T+T+T+'<Description>'+n(g('Modtager by')||g('Modtager land'))+'</Description>');
    L.push(T+T+T+'</TermsOfDelivery>');
    L.push(T+T+T+'<FreightLocalCode>'+(isExport?'X':'X')+'</FreightLocalCode>');
    // Goodsnumber EFTER FreightLocalCode (korrekt rækkefølge bekræftet i korrekte filer)
    if (!isNO || !isExport) {
      L.push(T+T+T+'<Goodsnumber>');
      L.push(T+T+T+T+'<Number></Number>');
      L.push(T+T+T+'</Goodsnumber>');
    }
    L.push(T+T+T+'<TransactionCode>01</TransactionCode>');
    L.push(T+T+T+'<Transport>');
    const noBorderId = (transport && transport.borderId) ? String(transport.borderId).trim() : '';
    const noBorderNat = (transport && transport.borderNat) ? String(transport.borderNat).trim() : (isExport?afsLand:'DK');
    L.push(T+T+T+T+'<BorderID>'+xmlEsc(noBorderId)+'</BorderID>');
    L.push(T+T+T+T+'<BorderNationality>'+xmlEsc(noBorderNat)+'</BorderNationality>');
    L.push(T+T+T+T+'<Method>30</Method>');
    if (!isExport) L.push(T+T+T+T+'<MethodDomestic>3</MethodDomestic>');
    L.push(T+T+T+'</Transport>');

  } else {
    // ═══════════════════════════════════════════════════════════
    // DANSK — Import eller Eksport
    // ═══════════════════════════════════════════════════════════
    if (isExport) {
      L.push(T+T+'<ExportDeclaration>');
      L.push(T+T+T+'<Reference>'+xmlEsc(ref)+'</Reference>');
      L.push(T+T+T+'<LRN></LRN>');
      L.push(T+T+T+'<ExpectedArrival>'+(today.substring(0,10))+'</ExpectedArrival>');
      L.push(T+T+T+'<DeclarationType>EX</DeclarationType>');
      L.push(T+T+T+'<DeclarationSubType>A</DeclarationSubType>');
      L.push(T+T+T+'<TotalNumPackages>'+xmlEsc(kolli)+'</TotalNumPackages>');
      L.push(T+T+T+'<TotalGrossWeight>'+xmlEsc(bvAlt)+'</TotalGrossWeight>');
      L.push(T+T+T+'<TotalNetWeight>'+xmlEsc(nvAlt)+'</TotalNetWeight>');
      L.push(T+T+T+'<Shipper>');
      if (afsTin) L.push(T+T+T+T+'<TIN>'+afsTin+'</TIN>');
      L.push(T+T+T+T+'<Name>'+n(g('Afsender navn'))+'</Name>');
      L.push(T+T+T+T+'<Address>'+n(g('Afsender gade'))+'</Address>');
      if (g('Afsender postnummer')) L.push(T+T+T+T+'<PostalCode>'+xmlEsc(normPostalCode(g('Afsender postnummer')))+'</PostalCode>');
      if (g('Afsender by')) L.push(T+T+T+T+'<City>'+n(g('Afsender by'))+'</City>');
      L.push(T+T+T+T+'<CountryCode>'+afsLand+'</CountryCode>');
      L.push(T+T+T+'</Shipper>');
      L.push(T+T+T+'<Consignee>');
      L.push(T+T+T+T+'<Name>'+n(g('Modtager navn'))+'</Name>');
      L.push(T+T+T+T+'<Address>'+n(g('Modtager gade'))+'</Address>');
      if (g('Modtager postnummer')) L.push(T+T+T+T+'<PostalCode>'+xmlEsc(normPostalCode(g('Modtager postnummer')))+'</PostalCode>');
      if (g('Modtager by')) L.push(T+T+T+T+'<City>'+n(g('Modtager by'))+'</City>');
      L.push(T+T+T+T+'<CountryCode>'+modLand+'</CountryCode>');
      L.push(T+T+T+'</Consignee>');
      L.push(T+T+T+'<Declarant>');
      // Declarant - klareren = eksportoeren (afsender) ved DK eksport.
      // Komplet adresse er paakraevet fordi Emma ikke altid kan slaa firmaet op via TIN alene
      // (vi har ikke Emma's InternalID for kunden, som ville tillade opslag).
      if (afsTin) L.push(T+T+T+T+'<TIN>'+afsTin+'</TIN>');
      L.push(T+T+T+T+'<Name>'+n(g('Afsender navn'))+'</Name>');
      L.push(T+T+T+T+'<Address>'+n(g('Afsender gade'))+'</Address>');
      if (g('Afsender postnummer')) L.push(T+T+T+T+'<PostalCode>'+xmlEsc(normPostalCode(g('Afsender postnummer')))+'</PostalCode>');
      if (g('Afsender by')) L.push(T+T+T+T+'<City>'+n(g('Afsender by'))+'</City>');
      L.push(T+T+T+T+'<CountryCode>'+afsLand+'</CountryCode>');
      L.push(T+T+T+T+'<RepresentationStatus>2</RepresentationStatus>');
      L.push(T+T+T+'</Declarant>');
      L.push(T+T+T+'<DestinationCountry>'+modLand+'</DestinationCountry>');
      // TermsOfDelivery — Emma bruger simpel Description (fx "SON") + CountryCode (destinations-land)
      L.push(T+T+T+'<TermsOfDelivery>');
      L.push(T+T+T+T+'<Code>'+incoterms+'</Code>');
      L.push(T+T+T+T+'<Description>'+n(g('Modtager by') || g('Modtager land') || modLand)+'</Description>');
      L.push(T+T+T+T+'<CountryCode>'+modLand+'</CountryCode>');
      L.push(T+T+T+'</TermsOfDelivery>');
      // Transport — tilpas efter toldsted og transporttype
      const dkToldsted = (transport && transport.toldsted) ? transport.toldsted : 'DK003102';
      const erBaad = (transport && transport.erBaad !== undefined) ? transport.erBaad : (dkToldsted === 'DK003102');
      const dkExitToldsted = (transport && transport.exitToldsted) ? transport.exitToldsted : dkToldsted;
      L.push(T+T+T+'<CustomsCode>'+xmlEsc(dkToldsted)+'</CustomsCode>');
      L.push(T+T+T+'<ExitCustomsOffice>'+xmlEsc(dkExitToldsted)+'</ExitCustomsOffice>');
      // Transport — Emma's format: ArrivalID og BorderID er ALTID samme bilnummer (DD54259),
      // og Method/MethodDomestic er altid begge der uanset om det er bil eller båd
      const bilnrRaw = (transport && (transport.arrivalId || transport.borderId)) || '';
      const bilnr = bilnrRaw ? xmlEsc(bilnrRaw) : '';
      const arrNat = (transport && transport.arrivalNat) ? xmlEsc(transport.arrivalNat) : 'DK';
      const bordNat = (transport && transport.borderNat) ? xmlEsc(transport.borderNat) : 'DK';
      L.push(T+T+T+'<Transport>');
      L.push(T+T+T+T+'<ArrivalID>'+bilnr+'</ArrivalID>');
      L.push(T+T+T+T+'<ArrivalNationality>'+arrNat+'</ArrivalNationality>');
      L.push(T+T+T+T+'<BorderID>'+bilnr+'</BorderID>');
      L.push(T+T+T+T+'<BorderNationality>'+bordNat+'</BorderNationality>');
      L.push(T+T+T+T+'<Method>3</Method>');
      L.push(T+T+T+T+'<MethodDomestic>3</MethodDomestic>');
      L.push(T+T+T+'</Transport>');
      // PreviousDocuments på deklarations-niveau er fjernet
      // (er KUN på GoodsItem-niveau i Emma's format)
    } else {
      // DK IMPORT
      L.push(T+T+'<ImportDeclaration>');
      L.push(T+T+T+'<Reference>'+xmlEsc(ref)+'</Reference>');
      L.push(T+T+T+'<LRN></LRN>');
      L.push(T+T+T+'<MessageType>H1</MessageType>');
      L.push(T+T+T+'<DeclarationType>IM</DeclarationType>');
      L.push(T+T+T+'<DeclarationSubType>D</DeclarationSubType>');
      L.push(T+T+T+'<TotalNumPackages>'+xmlEsc(kolli)+'</TotalNumPackages>');
      L.push(T+T+T+'<TotalGrossWeight>'+xmlEsc(bvAlt)+'</TotalGrossWeight>');
      L.push(T+T+T+'<TotalNetWeight>'+xmlEsc(nvAlt)+'</TotalNetWeight>');
      L.push(T+T+T+'<Shipper>');
      L.push(T+T+T+T+'<Name>'+n(g('Afsender navn'))+'</Name>');
      L.push(T+T+T+T+'<Address>'+n(g('Afsender gade'))+'</Address>');
      if (g('Afsender postnummer')) L.push(T+T+T+T+'<PostalCode>'+xmlEsc(normPostalCode(g('Afsender postnummer')))+'</PostalCode>');
      if (g('Afsender by')) L.push(T+T+T+T+'<City>'+n(g('Afsender by'))+'</City>');
      L.push(T+T+T+T+'<CountryCode>'+afsLand+'</CountryCode>');
      L.push(T+T+T+'</Shipper>');
      L.push(T+T+T+'<Consignee>');
      if (tinClean) L.push(T+T+T+T+'<TIN>'+tinClean+'</TIN>');
      L.push(T+T+T+T+'<Name>'+n(g('Modtager navn'))+'</Name>');
      L.push(T+T+T+T+'<Address>'+n(g('Modtager gade'))+'</Address>');
      if (g('Modtager postnummer')) L.push(T+T+T+T+'<PostalCode>'+xmlEsc(normPostalCode(g('Modtager postnummer')))+'</PostalCode>');
      if (g('Modtager by')) L.push(T+T+T+T+'<City>'+n(g('Modtager by'))+'</City>');
      L.push(T+T+T+T+'<CountryCode>'+modLand+'</CountryCode>');
      L.push(T+T+T+'</Consignee>');
      L.push(T+T+T+'<Declarant>');
      if (tinClean) L.push(T+T+T+T+'<TIN>'+tinClean+'</TIN>');
      L.push(T+T+T+T+'<Name>'+n(g('Modtager navn'))+'</Name>');
      L.push(T+T+T+T+'<Address>'+n(g('Modtager gade'))+'</Address>');
      if (g('Modtager postnummer')) L.push(T+T+T+T+'<PostalCode>'+xmlEsc(normPostalCode(g('Modtager postnummer')))+'</PostalCode>');
      if (g('Modtager by')) L.push(T+T+T+T+'<City>'+n(g('Modtager by'))+'</City>');
      L.push(T+T+T+T+'<CountryCode>'+modLand+'</CountryCode>');
      L.push(T+T+T+'</Declarant>');
      L.push(T+T+T+'<Representative>');
      L.push(T+T+T+T+'<TIN>DK43083910</TIN>');
      L.push(T+T+T+T+'<InternalID>67</InternalID>');
      L.push(T+T+T+T+'<Name>CW Spedition Aps</Name>');
      L.push(T+T+T+T+'<RepresentationStatus>2</RepresentationStatus>');
      L.push(T+T+T+'</Representative>');
      L.push(T+T+T+'<DispatchCountry>'+afsLand+'</DispatchCountry>');
      L.push(T+T+T+'<DestinationCountry>'+modLand+'</DestinationCountry>');
      const dkImToldsted = (transport && transport.toldsted) ? transport.toldsted : 'DK003102';
      L.push(T+T+T+'<CustomsCode>'+xmlEsc(dkImToldsted)+'</CustomsCode>');
      L.push(T+T+T+'<PresentationOffice>'+xmlEsc(dkImToldsted)+'</PresentationOffice>');
      L.push(T+T+T+'<TermsOfDelivery>');
      L.push(T+T+T+T+'<Code>'+incoterms+'</Code>');
      L.push(T+T+T+T+'<LocationName>'+n(g('Modtager by')||g('Modtager land'))+'</LocationName>');
      L.push(T+T+T+T+'<CountryCode>'+modLand+'</CountryCode>');
      L.push(T+T+T+'</TermsOfDelivery>');
      L.push(T+T+T+'<LocationOfGoods>');
      L.push(T+T+T+T+'<Type>A</Type>');
      L.push(T+T+T+T+'<Qualifier>V</Qualifier>');
      L.push(T+T+T+T+'<CustomsOffice>'+xmlEsc(dkImToldsted)+'</CustomsOffice>');
      L.push(T+T+T+'</LocationOfGoods>');
      L.push(T+T+T+'<TransactionCode>11</TransactionCode>');
      L.push(T+T+T+'<PaymentMethod>H</PaymentMethod>');
      L.push(T+T+T+'<Transport>');
      const dkImBorderId = (transport && transport.borderId) ? transport.borderId : '';
      const dkImBorderNat = (transport && transport.borderNat) ? transport.borderNat : 'DK';
      if (dkImBorderId) L.push(T+T+T+T+'<BorderID>'+xmlEsc(dkImBorderId)+'</BorderID>');
      L.push(T+T+T+T+'<BorderNationality>'+xmlEsc(dkImBorderNat)+'</BorderNationality>');
      L.push(T+T+T+T+'<Method>3</Method>');
      L.push(T+T+T+T+'<MethodDomestic>3</MethodDomestic>');
      L.push(T+T+T+T+'<TypeDomestic>30</TypeDomestic>');
      L.push(T+T+T+'</Transport>');
    }
  }

  // ─── Fakturaer (fælles) ───────────────────────────────────────────────────
  L.push(T+T+T+'<Invoices>');
  fakturaer.forEach(function(f) {
    const dato = formatDato(f.fakturadato || f.dato, today);
    const valuta = xmlEsc(f.valuta || (isNO ? 'NOK' : 'DKK'));
    L.push(T+T+T+T+'<Invoice>');
    L.push(T+T+T+T+T+'<InvoiceNumber>'+xmlEsc(f.fakturanummer||'')+'</InvoiceNumber>');
    L.push(T+T+T+T+T+'<Amount Currency="'+valuta+'">'+normBeloeb(f.beloeb)+'</Amount>');
    L.push(T+T+T+T+T+'<Date>'+dato+'</Date>');
    // ExchangeRate: faktisk kurs fra faktura (100 = NOK/DKK, fx 11.23 = EUR->NOK)
    const exchRateVal = parseFloat((f.vekselkurs || '').replace(',','.')) || 100;
    L.push(T+T+T+T+T+'<ExchangeRate>'+(exchRateVal !== 100 ? exchRateVal : 100)+'</ExchangeRate>');
    L.push(T+T+T+T+'</Invoice>');
  });
  L.push(T+T+T+'</Invoices>');

  // ─── Varelinjer (fælles) ──────────────────────────────────────────────────
  const bvTotNum = parseFloat(bvAlt) || 0;
  const nvTotNum = parseFloat(nvAlt) || 0;
  const nettoRatio = (bvTotNum > 0 && nvTotNum > 0 && bvTotNum !== nvTotNum) ? (nvTotNum / bvTotNum) : 1;
  const valutaFaelles = xmlEsc(isNO ? 'NOK' : 'DKK');

  // Beregn total beløb for vægt-fordeling
  const totalBeloeb = varelinjer.reduce(function(sum, v) { return sum + (parseFloat(normBeloeb(v.beloeb))||0); }, 0);
  const vægte = beregnVarelinjeVægte(varelinjer, bvTotNum, nvTotNum);

  L.push(T+T+T+'<Items>');
  varelinjer.forEach(function(v, vIdx) {
    const bv = vægte[vIdx].bv;
    const nv = vægte[vIdx].nv;
    // Statistical: beloeb konverteret til NOK via vekselkurs
    const beloebNum = parseFloat(normBeloeb(v.beloeb)) || 0;
    const faktVekselkurs = parseFloat(((fakturaer[0] && fakturaer[0].vekselkurs) || '').replace(',','.')) || 100;
    let stat;
    if (faktVekselkurs === 100) {
      // NOK faktura — ingen omregning
      stat = Math.round(beloebNum * 100) / 100;
    } else if (faktVekselkurs > 20) {
      // DKK/SEK osv. — kurs udtrykt per 100 enheder (fx 150.04 = 150.04 NOK per 100 DKK)
      stat = Math.round(beloebNum * faktVekselkurs / 100 * 100) / 100;
    } else {
      // EUR/USD/GBP osv. — kurs er direkte faktor (fx 11.21 = 11.21 NOK per EUR)
      stat = Math.round(beloebNum * faktVekselkurs * 100) / 100;
    }
    const totalKolli = parseInt(kolli)||1;
    // Kolli-fordeling: første varelinje får hele totalen, øvrige linjer får 0
    // (Emma's krav — antal kolli må ikke tælles dobbelt ved at stå på flere linjer)
    const pkAntal = (vIdx===0) ? totalKolli : 0;


    L.push(T+T+T+T+'<GoodsItem>');
    const hskode = (v.hs_kode||'').replace(/\D/g,'').substring(0,8);
    L.push(T+T+T+T+T+'<CommodityCode>'+hskode+'</CommodityCode>');
    L.push(T+T+T+T+T+'<Value>'+normBeloeb(v.beloeb)+'</Value>');
    const coo = normCOO(v.coo) === 'XX' ? '' : normCOO(v.coo);
    if (coo) L.push(T+T+T+T+T+'<Origin>'+coo+'</Origin>');
    // CountyOfOrigin>99: KUN i NO eksport (ikke import)
    if (isNO && isExport) L.push(T+T+T+T+T+'<CountyOfOrigin>99</CountyOfOrigin>');
    L.push(T+T+T+T+T+'<GrossWeight>'+bv+'</GrossWeight>');
    L.push(T+T+T+T+T+'<NetWeight>'+nv+'</NetWeight>');
    // Packaging: for alle moduler — Emma kræver Packaging på GoodsItem
    L.push(T+T+T+T+T+'<Packaging>');
    L.push(T+T+T+T+T+T+'<Packages>');
    L.push(T+T+T+T+T+T+T+'<PackageType>PK</PackageType>');
    L.push(T+T+T+T+T+T+T+'<NumPackages>'+pkAntal+'</NumPackages>');
    if (isNO) L.push(T+T+T+T+T+T+T+'<MarksAndNumber>Addr</MarksAndNumber>');
    if (!isNO && !isExport) L.push(T+T+T+T+T+T+T+'<MarksAndNumber>ADR</MarksAndNumber>');
    L.push(T+T+T+T+T+T+'</Packages>');
    L.push(T+T+T+T+T+'</Packaging>');
    // OtherUnit: KUN for HS-koder der kræver supplementary unit i NO/DK tarif
    // Strict whitelist — skriv ALDRIG antal for koder ikke på listen
    const hs4 = (v.hs_kode||'').replace(/\D/g,'').substring(0,4);
    const unitMap = {
      // Skruer, bolte, møtrikker (kap 7318) — styk
      '7318': 'NAR', '7317': 'NAR', '7326': 'NAR', '7415': 'NAR', '7907': 'NAR',
      // Håndværktøj og haveværktøj (kap 82)
      '8201': 'NAR', '8202': 'NAR', '8203': 'NAR', '8204': 'NAR',
      '8205': 'NAR', '8206': 'NAR', '8207': 'NAR', '8208': 'NAR', '8211': 'NAR',
      // Pumper, kompressorer, husholdningsapparater
      '8302': 'NAR', '8414': 'NAR', '8415': 'NAR', '8418': 'NAR',
      '8421': 'NAR', '8422': 'NAR', '8450': 'NAR', '8451': 'NAR',
      '8479': 'NAR', '8516': 'NAR',
      // Måleudstyr og bearbejdning
      '9031': 'NAR',
      // Møbler og husholdningsartikler
      '9401': 'NAR', '9402': 'NAR', '9403': 'NAR', '9404': 'NAR',
      // Keramik og sanitær
      '6910': 'NAR',
      // Emballage og plastkroge
      '3926': 'NAR', '4819': 'NAR',
      // Køretøjer
      '8701': 'NAR', '8702': 'NAR', '8703': 'NAR', '8704': 'NAR',
      '8705': 'NAR', '8711': 'NAR', '8712': 'NAR',
      // Børster og koste
      '9603': 'NAR',
      // Alkohol — liter
      '2203': 'LTR', '2204': 'LTR', '2205': 'LTR', '2206': 'LTR',
      '2207': 'LTR', '2208': 'LTR', '2209': 'LTR',
      // Energi — kWh
      '2716': 'KWH',
    };
    const unitType = unitMap[hs4];
    const antalInt = v.antal ? parseInt(v.antal) : 0;
    if (!isNO && isExport) {
      // DK Export: ALTID <OtherUnit> med antal hvis udfyldt, ellers 1 (som default i Emma-reference)
      L.push(T+T+T+T+T+'<OtherUnit>'+(antalInt > 0 ? antalInt : 1)+'</OtherUnit>');
    } else if (unitType && antalInt > 0) {
      // DK Import / NO: Kun hvis HS-koden kraever det OG antal er udfyldt
      L.push(T+T+T+T+T+'<OtherUnit>'+antalInt+'</OtherUnit>');
      // OtherUnitType maa ALDRIG med i NO
      if (!isNO) L.push(T+T+T+T+T+'<OtherUnitType>'+unitType+'</OtherUnitType>');
    }
    L.push(T+T+T+T+T+'<Description>'+xmlEsc(trunc35(v.beskrivelse))+'</Description>');
    L.push(T+T+T+T+T+'<Procedure>'+(isExport?'10':'40')+'</Procedure>');
    L.push(T+T+T+T+T+'<PreviousProcedure>'+(isNO&&isExport?'00':(!isNO&&!isExport?'00':'00'))+'</PreviousProcedure>');
    if (!isNO) L.push(T+T+T+T+T+'<SupplementaryProcedure>000</SupplementaryProcedure>');
    // NO: Preference J for EU-oprindelse (toldfrihed), N for ikke-EU
    // EU-lande: DK, DE, SE, FI, NL, BE, FR, PL, CZ, AT, IT, ES, PT, IE osv.
    const euCountries = new Set(['AT','BE','BG','CY','CZ','DE','DK','EE','ES','FI','FR','GR','HR','HU','IE','IT','LT','LU','LV','MT','NL','PL','PT','RO','SE','SI','SK']);
    const cooForPref = normCOO(v.coo);
    const eeaCountries = new Set(['NO','IS','LI']);
    let dkImportPreference = '000';
    if (euCountries.has(cooForPref)) dkImportPreference = '100';
    if (eeaCountries.has(cooForPref)) dkImportPreference = '300';
    const noPreference = isNO ? (euCountries.has(cooForPref) ? 'J' : 'N') : (isExport ? '' : dkImportPreference);
    if (noPreference) L.push(T+T+T+T+T+'<Preference>'+noPreference+'</Preference>');
    // ValuationMethod FØR Values (bekræftet i rigtige DK import + NO import filer)
    if (!isExport || isNO) L.push(T+T+T+T+T+'<ValuationMethod>1</ValuationMethod>');
    L.push(T+T+T+T+T+'<Values>');
    // Additionally og Deduction: kun NO (Emma fylder selv for DK import)
    if (isNO) {
      L.push(T+T+T+T+T+T+'<Additionally Currency="'+valutaFaelles+'">0</Additionally>');
      L.push(T+T+T+T+T+T+'<Deduction Currency="'+valutaFaelles+'">0</Deduction>');
    }
    // Statistical har altid Currency attribut (NOK for NO, DKK for DK)
    L.push(T+T+T+T+T+T+'<Statistical Currency="'+valutaFaelles+'">'+stat+'</Statistical>');
    L.push(T+T+T+T+T+'</Values>');
    // PreviousDocuments paa GoodsItem-niveau (N380 = faktura) — for DK Export
    if (!isNO && isExport) {
      L.push(T+T+T+T+T+'<PreviousDocuments>');
      fakturaer.forEach(function(f) {
        L.push(T+T+T+T+T+T+'<PreviousDocument>');
        L.push(T+T+T+T+T+T+T+'<Code>N380</Code>');
        L.push(T+T+T+T+T+T+T+'<Reference>'+xmlEsc(f.fakturanummer||'')+'</Reference>');
        L.push(T+T+T+T+T+T+'</PreviousDocument>');
      });
      L.push(T+T+T+T+T+'</PreviousDocuments>');
      L.push(T+T+T+T+T+'<StatisticalValue>'+stat+'</StatisticalValue>');
    }
    L.push(T+T+T+T+'</GoodsItem>');
  });
  L.push(T+T+T+'</Items>');

  if (!isNO && !isExport) {
    L.push(T+T+T+'<Documents>');
    fakturaer.forEach(function(f) {
      L.push(T+T+T+T+'<Document>');
      L.push(T+T+T+T+T+'<Code>N380</Code>');
      L.push(T+T+T+T+T+'<Type>TD</Type>');
      L.push(T+T+T+T+T+'<Reference>'+xmlEsc(f.fakturanummer||'')+'</Reference>');
      L.push(T+T+T+T+'</Document>');
    });
    L.push(T+T+T+'</Documents>');
  }

  // MRN fra eksportangivelse (kun NO import, kun hvis angivet)
  if (isNO && !isExport && mrn) {
    L.push(T+T+T+'<PreviousDocument>');
    L.push(T+T+T+T+'<Document>'+xmlEsc(mrn.trim())+'</Document>');
    L.push(T+T+T+'</PreviousDocument>');
  }

  // CustomsApproval: Emma tilføjer selv — vi sender den ikke

  L.push(T+T+'</'+(isExport?'ExportDeclaration':'ImportDeclaration')+'>')
  L.push(T+'</Declaration>');
  L.push('</EmmaCustomsDeclaration>');
  return L.join(NL);
}

// ─── SFTP Test endpoint ───────────────────────────────────────────────────────
app.get('/api/test-sftp', async (req, res) => {
  const ts = new Date().toISOString();
  const results = [];

  const testFiles = [
    { module: 'DK', folder: '/dk', filename: 'cwspedition_test_DK.xml' },
    { module: 'NO', folder: '/no', filename: 'cwspedition_test_NO.xml' }
  ];

  for (const t of testFiles) {
    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!-- CW Spedition SFTP Test -->',
      '<EmmaCustomsDeclaration>',
      '  <ExchangeID>TEST/' + Date.now() + '</ExchangeID>',
      '  <Module>' + t.module + '</Module>',
      '  <GeneratedTimestamp>' + ts + '</GeneratedTimestamp>',
      '  <TestNote>Denne fil er en SFTP-forbindelsestest fra CW Spedition. Den kan slettes.</TestNote>',
      '</EmmaCustomsDeclaration>'
    ].join('\r\n');

    const sftp = new SftpClient();
    try {
      await sftp.connect(SFTP_CONFIG);
      const buf = Buffer.from(xml, 'utf8');
      const remotePath = t.folder + '/' + t.filename;
      await sftp.put(buf, remotePath);
      await sftp.end();
      console.log('SFTP test OK: ' + remotePath);
      results.push({ module: t.module, path: remotePath, ok: true });
    } catch(err) {
      console.error('SFTP test fejl (' + t.module + '):', err.message);
      try { await sftp.end(); } catch(e) {}
      results.push({ module: t.module, path: t.folder + '/' + t.filename, ok: false, error: err.message });
    }
  }

  const allOk = results.every(r => r.ok);
  res.json({ ok: allOk, timestamp: ts, results });
});

// ─── API endpoints ────────────────────────────────────────────────────────────
app.post('/api/extract-all', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API noegle ikke konfigureret.' });

  try {
    // ─── Multi-PDF merge: accepter b64Array (flere filer) eller enkelt b64 ────
    let b64;
    const b64Array = req.body.b64Array;
    if (b64Array && Array.isArray(b64Array) && b64Array.length > 1) {
      console.log('Merger ' + b64Array.length + ' PDF-filer...');
      const mergedPdf = await PDFDocument.create();
      for (let i = 0; i < b64Array.length; i++) {
        try {
          const bytes = Buffer.from(b64Array[i], 'base64');
          const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
          const pages = await mergedPdf.copyPages(src, src.getPageIndices());
          pages.forEach(p => mergedPdf.addPage(p));
          console.log('PDF ' + (i+1) + ': ' + src.getPageCount() + ' sider tilfojet');
        } catch(e) {
          console.log('PDF ' + (i+1) + ' merge fejl (springer over):', e.message);
        }
      }
      const mergedBytes = await mergedPdf.save();
      b64 = Buffer.from(mergedBytes).toString('base64');
      console.log('Merger faerdig: ' + mergedPdf.getPageCount() + ' sider i alt');
    } else {
      b64 = req.body.b64 || (b64Array && b64Array[0]);
    }
    if (!b64) return res.status(400).json({ error: 'Ingen PDF data modtaget.' });

    // ─── PDF størrelse logging ─────────────────────────────────────────────────
    const pdfSizeBytes = Math.round(b64.length * 0.75);
    const pdfSizeMB = (pdfSizeBytes / 1024 / 1024).toFixed(2);
    console.log('PDF størrelse: ' + pdfSizeMB + ' MB (' + pdfSizeBytes + ' bytes)');
    if (pdfSizeBytes > 30 * 1024 * 1024) {
      return res.status(400).json({ error: 'PDF er for stor (' + pdfSizeMB + ' MB). Max 30 MB.' });
    }

    // ─── Header — send hele PDF (totaler kan stå på sidste side) ──────────────
    console.log('Henter header...');
    let headerB64 = b64;
    try {
      const pdfBytes = Buffer.from(b64, 'base64');
      const srcPdf = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
      const numPages = srcPdf.getPageCount();
      console.log('PDF sider i alt: ' + numPages);
      // Hvis PDF er meget stor (>20 sider), send første 10 + sidste 5 sider for at spare tokens
      // men sikre at totaler på slutsiden altid er med
      if (numPages > 25) {
        const headerPdf = await PDFDocument.create();
        const indices = new Set();
        // Første 10 sider
        for (let p = 0; p < Math.min(10, numPages); p++) indices.add(p);
        // Sidste 5 sider (indeholder typisk totaler og opsummering)
        for (let p = Math.max(0, numPages - 5); p < numPages; p++) indices.add(p);
        const uniqueIndices = [...indices].sort((a,b)=>a-b);
        const copied = await headerPdf.copyPages(srcPdf, uniqueIndices);
        copied.forEach(p => headerPdf.addPage(p));
        const headerBytes = await headerPdf.save();
        headerB64 = Buffer.from(headerBytes).toString('base64');
        const headerMB = (headerBytes.length / 1024 / 1024).toFixed(2);
        console.log('Header PDF (stor): sider ' + uniqueIndices.map(i=>i+1).join(',') + ' (' + headerMB + ' MB)');
      } else {
        console.log('Header PDF: alle ' + numPages + ' sider sendes');
      }
    } catch(e) {
      console.log('Header PDF fejl, bruger hel PDF:', e.message);
    }

    const hPrompt = [
      'Du er toldspeditionsekspert. Udtræk header-data fra dette dokument.',
      'Svar KUN med JSON uden markdown eller forklaring.',
      '',
      'VIGTIGE REGLER:',
      '- Afsender navn: DET FIRMA DER UDSTEDER FAKTURAEN — find det på fakturaen (typisk øverst sammen med VAT/CVR-nummer). DETTE OVERTRUMFER ALT ANDET. Hvis dokumentpakken indeholder Air Waybill, CMR, Bill of Lading eller anden fragt-følgeseddel hvor en helt anden virksomhed står som "Shipper" (fx en logistikpartner i Dubai eller et booking-firma) — IGNORÉR den. Toldafsenderen er ALTID den der udsteder fakturaen, ikke den der booker fragten. Eksempel: hvis fakturaen er udstedt af "Ventiq AS, Norway" og Air Waybill viser "WORLD GLOBZ SUPPLY, Dubai" som Shipper → afsender er Ventiq AS, ikke WORLD GLOBZ SUPPLY.',
      '- Modtager navn: DET FIRMA DER FAKTURAEN ER UDSTEDT TIL — typisk angivet som Bill to, Sold to, Customer, eller adresseret til på fakturaen. MÅ IKKE være det samme firma som afsender. VIGTIGT: Hvis adressen indeholder "C/O" skal du bruge firmanavnet FØR C/O-linjen, ikke C/O-firmaet. Eksempel: "AUBO Production A/S - Norge / C/O IntraVAT AS" → modtager er "AUBO Production A/S - Norge", ikke "IntraVAT AS".',
      '- Afsender gade: vejnavn og nummer UDEN postnummer og by',
      '- Afsender postnummer: KUN postnummeret som tal',
      '- Afsender by: KUN bynavnet',
      '- Modtager gade: vejnavn og nummer UDEN postnummer og by',
      '- Modtager postnummer: KUN postnummeret som tal',
      '- Modtager by: KUN bynavnet',
      '- Incoterms: altid 3-bogstavs kode. Oversaet: Delivered at place=DAP, Delivered duty paid=DDP, Ex works=EXW, Free on board=FOB, Cost+insurance+freight=CIF, Carriage paid to=CPT, Carriage and insurance paid=CIP. Skriv altid koden ikke teksten.',
      '- Landekode: altid 2 bogstaver (DK, NO, DE, GB osv.)',
      '- Valuta: 3 bogstaver (DKK, NOK, EUR osv.)',
      '- Afregningsreference: fakturanummer eller sagsnummer - typisk et tal som 17693',
      '- Afsender CVR/VAT: brug ALTID det almindelige "CVR/SE-Nr" eller "CVR-nr" (IKKE "CVR/SE-Nr Eksport" — den er beregnet til andre formål i Emma). For AUBO: brug værdien efter "CVR/SE-Nr:" (fx 28854846), IKKE værdien efter "CVR/SE-Nr Eksport"',
      '- Modtager CVR/VAT: se efter "Org no", "Org nr", "Org.Nr", "Organization number", "CVR", "VAT", "MVA" i modtagerens adressesektion. Eksempel: "Org no 831 313 862" giver værdien "831313862". VIGTIGT: find nummeret der hører til modtageren, ikke afsenderens Org/VAT nummer i sidefoden.',
      '- Tollkreditt: se efter "Tollkreditt:", "Tollkreditt nr.", "Toll credit", "Custom Credit", "Customs Credit", "Credit number" efterfulgt af et tal. KUN relevant for norske fakturaer. Eksempel: "Tollkreditt: 30936780" eller "Custom Credit 33491531" giver vaerdi 30936780 hhv. 33491531.',
      '- MRN: VIGTIGT - skriv altid MRN i dette felt hvis du finder den i dokumentet. MRN er en eksportangivelses-referencekode der starter med 2 cifre efterfulgt af 2 landebogstaver, fx "26DE613382940534B6" eller "26DKDEH6JMOJGRTHA7". Find MRN på: (1) CMR-fragtbrev felt 13 "MRN-Nr.:", (2) Tysk Ausfuhrbegleitdokument felt øverst højre "BKP MRN", (3) SAD-eksportdokument. Skriv KUN selve koden - IKKE i notes-feltet. Eksempel: hvis dokumentet viser "MRN-Nr.: 26DE613382940534B6" skal MRN-feltet have værdien "26DE613382940534B6".',
      '- vekselkurs: valutakurs for fakturavalutaen til NOK/DKK (fx 11.23 for EUR->NOK). Skriv 100 hvis fakturaen er i NOK eller DKK.',
      '- fakturanummer i fakturaer[]: find det EKSAKTE nummer ved siden af "Proforma Invoice:", "Invoice:", "order number:", "Fakturanummer:", eller lignende. I samlefaktura-dokumenter kan der være FLERE fakturaer — medtag dem ALLE. Eksempel: et CASCOO-dokument kan have 3 separate "Proforma Invoice: 2026-XXXXXX" numre spredt ud over siderne. IGNORER "debit reference" (det er kundens bestillingsnr), "debit number" (kundenr), og ordrenummer i sidehoved.',
      '- fakturadato i fakturaer[]: find "order date:", "Date of invoice:", "Fakturadato:", "Bogf. dato", eller lignende. Hver faktura har sin egen dato. VIGTIGT om datoformat: "23-04-26" øverst på en AUBO-faktura betyder 23. april 2026 (format dd-mm-yy), IKKE 26. april 2023. Returnér datoen præcis som den står i dokumentet (systemet konverterer selv bagefter). For AUBO-samlefakturaer står datoen i øverste højre hjørne ved siden af samle-fakturanummeret.',
      '- beloeb i fakturaer[]: Brug fakturaens egen total — det beløb fakturaen viser som "Total", "Subtotal", "Net Amount", "Invoice amount" eller "Toldværdi". Hvis fakturaen har en FREIGHT/Fragt-linje som en del af linjeoversigten (med eget beløb der indgår i fakturaens subtotal), skal det beløb IKKE fratrækkes — det er en del af fakturabeløbet. Kun hvis fragten er en separat opgørelse UDENFOR fakturaen (fx en separat fragtfaktura eller "Freight Expenses" listet under totalen som en tilføjelse) skal den ekskluderes. I tvivlstilfælde: brug det beløb fakturaen selv lister som sit endelige total. Hvis beløbet er tomt kan du summere varelinjebeløbene.',
      '- valuta i fakturaer[]: brug valutaen der er angivet ved beloebstotalen (fx "NOK 1.488.783,85" = NOK). Overstyr IKKE til EUR hvis fakturaen angiver beloeb i NOK.',
      '- Oprindelsesland: find COO kolonnen i varelinjer - hvis alle er DK sæt DK, hvis alle er NO sæt NO',
      '- Antal kolli: se efter "Cll:", "Kolli", "Packages", "Collis", "Number of packages"',
      '- DOKUMENTTYPE-PRIORITERING: Et dokument kan indeholde flere dokumenttyper blandet. Følg disse regler strengt:',
      '  1. IMO-dokumenter / farligt gods-erklæringer (kendes på "TRANSPORT DOCUMENT FOR DANGEROUS GOODS", "IMO-Erklärung", "IMDG", "UN-Nr.", "Beförderungsdokument"): IGNORER fuldstændigt — hverken vægt, beløb eller varelinjer hentes herfra.',
      '  2. BELØB (Toldværdi / fakturabeløb): Hentes KUN fra sider mærket "INVOICE" med et fakturanummer og "Total amount payable" eller "TOTAL AMOUNT". Aldrig fra DELIVERY NOTE eller CMR.',
      '  3. VÆGT: Hentes primært fra INVOICE-sider (de har "Net weight X kg" / "Gross weight X kg" på slutsiden ved "Total amount payable"). Hvis INVOICE-siderne ikke indeholder vægt, brug da vægt fra CMR eller DELIVERY NOTE-sider. Ignorer vægt fra IMO-dokumenter altid.',
      '  4. Hvis dokumentet indeholder BÅDE "DELIVERY NOTE"-sider og "INVOICE"-sider: brug KUN vægt fra INVOICE-slutsiderne — ignorer alle "Net weight"/"Gross weight"-linjer der optræder på DELIVERY NOTE-sider.',
      '  5. Der kan være flere INVOICE-sider i samme dokument (fx faktura 1310543 og 1310982) — summer deres vægte og beløb til ét samlet tal.',
      '- Bruttovægt i alt: se efter "Brt. vægt:", "Bruttovægt:", "Gross weight, kg", "Gross weight:", "Brutto:", "GW:" efterfulgt af et tal PÅ EN INVOICE-SIDE. Skriv KUN tallet uden enhed og UDEN tusindtals-separator (10.314 skrives som 10314, 180 skrives som 180)',
      '- Nettovægt i alt: se efter "Nt. vægt:", "Nettovægt:", "Net weight, kg", "Net weight:", "Netto:", "NW:" efterfulgt af et tal PÅ EN INVOICE-SIDE. Skriv KUN tallet uden enhed og UDEN tusindtals-separator (9.280 skrives som 9280, 141.184 skrives som 141.184)',
      '- Brutto og netto er ALTID forskellige tal - hvis de ser ens ud har du laest forkert',
      '- OBS: I engelske dokumenter er "141.184" = 141,184 kg (punktum er decimaltegn ikke tusindtals). I danske/norske dokumenter er "10.314" = 10314 kg (punktum er tusindtals). Brug kontekst til at afgøre hvilket.',
      '- Samlede elementer / antal elementer er IKKE kolli - kolli er antal pakker/kasser',
      '- Oprindelsesland: find COO kolonnen i varelinjer - hvis alle er DK sæt DK, hvis alle er NO sæt NO',
      '{"doc_type":"","header":{"Afsender navn":{"value":"","confidence":"high"},"Afsender gade":{"value":"","confidence":"high"},"Afsender postnummer":{"value":"","confidence":"high"},"Afsender by":{"value":"","confidence":"high"},"Afsender land":{"value":"","confidence":"high"},"Afsender CVR/VAT":{"value":"","confidence":"high"},"Modtager navn":{"value":"","confidence":"high"},"Modtager gade":{"value":"","confidence":"high"},"Modtager postnummer":{"value":"","confidence":"high"},"Modtager by":{"value":"","confidence":"high"},"Modtager land":{"value":"","confidence":"high"},"Modtager CVR/VAT":{"value":"","confidence":"high"},"Tollkreditt":{"value":"","confidence":"high"},"MRN":{"value":"","confidence":"high"},"Afregningsreference":{"value":"","confidence":"high"},"Incoterms":{"value":"","confidence":"high"},"Transportmaade":{"value":"","confidence":"high"},"Oprindelsesland":{"value":"","confidence":"high"},"Valuta":{"value":"","confidence":"high"},"Fragtomkostning":{"value":"","confidence":"high"},"Forsikringsvaerdi":{"value":"","confidence":"high"},"Toldvaerdi i alt":{"value":"","confidence":"high"},"Antal kolli i alt":{"value":"","confidence":"high"},"Nettovægt i alt (kg)":{"value":"","confidence":"high"},"Bruttovægt i alt (kg)":{"value":"","confidence":"high"},"Maal / volumen i alt":{"value":"","confidence":"high"}},"fakturaer":[{"fakturanummer":"","fakturadato":"","beloeb":"","valuta":"","vekselkurs":""}],"notes":""}'
    ].join('\n');

    // ─── Kør header + første chunk PARALLELT for at spare tid ──────────────────
    // Varelinjer prompt defineres her så begge løber samtidig
    const vPrompt = [
      'Du er toldekspert. Udtræk ALLE varelinjer fra dette dokument.',
      'Svar KUN med pipe-separerede linjer, ingen forklaring, ingen overskrift, ingen markdown.',
      '',
      'Format: fakturanr|hs_kode|beskrivelse|bruttovægt|nettovægt|antal|coo|valuta|beloeb',
      '',
      'Regler:',
      '- hs_kode: toldpositionsnummer med mindst 6 og maksimalt 8 cifre (EU/NO standard). Find det i:',
      '  * En kolonne kaldet HS code, Tariff, Varekode, Toldnummer, Nummer, No., Tariffkode, Tolltariff',
      '  * En linje der starter med "Customs tariff number:" efterfulgt af koden',
      '  * En linje der starter med "Tolltarifnummer:", "Zolltarifnummer:", "Taric:"',
      '  * ALLERVIGTIGST om HS-koden — læs grundigt: Hver enkelt varelinje i tabellen har sin EGEN HS-kode i sin EGEN række. Læs koden fra den række du er på lige nu — kig i "Nummer"-kolonnen eller HS-kode-kolonnen til VENSTRE for beskrivelsen. REGLER DU SKAL FØLGE:',
      '    1. Brug ALTID den 6-8 cifrede kode der står ved DENNE specifikke varelinje — gæt ALDRIG en kode ud fra beskrivelsen hvis dokumentet har en kode',
      '    2. Selvom andre felter på linjen er tomme (fx antal-feltet), står koden stadig i Nummer-kolonnen og SKAL bruges præcis som den står',
      '    3. To linjer med ens beskrivelse kan have forskellige HS-koder — det er HELT NORMALT på samlefakturaer. Brug den specifikke kode for hver linje, ALDRIG en "general kode" baseret på beskrivelsen',
      '    4. Konkrete eksempler du SKAL respektere:',
      '       - "85166080 OVNE" → brug 85166080 (ikke 39269097 eller andet du gætter)',
      '       - "70099100 SPEJLE" → brug 70099100 (ikke 39269097)',
      '       - "84182159 KØLESKABE" og "84181080 KØLESKABE" → to forskellige koder for to forskellige køleskab-typer. Brug den SPECIFIKKE kode for hver linje. Gæt IKKE 94034010 (møbler) bare fordi en ANDEN linje i fakturaen havde 94034010',
      '       - "83021000 HÆNGSLER - SKINNER - GREB - TRÅDKURVE" → brug 83021000 (ikke 73269098 fordi det lyder som jern/stål)',
      '    5. Du må KUN gætte en HS-kode når dokumentet SLET IKKE har angivet en for den specifikke linje',
      '  * Tysk Ausfuhrbegleitdokument (ABD): find HS-koden i felt "Warennummer [18 09]" eller "Warenbezeichnung [18 05]" efterfulgt af en 8-cifret kode. Eksempel: "76020090" = aluminium scrap. IGNORER EWC-koder som 43109 - disse er europæiske affaldskoder og IKKE HS-toldkoder.',
      '  * EWC/AVV koder (4-5 cifre som 43109, 19 10 02, 17 04 02) er affaldskatalognumre - brug dem ALDRIG som HS-kode. Gæt i stedet HS-koden fra varebeskrivelsen.',
      '  * Hvis du IKKE kan finde en hs_kode i dokumentet, giv dit BEDSTE BUD baseret på varebeskrivelsen (du er toldekspert). Eksempler: aluminium scrap=76020000, kobber scrap=74040000, stål scrap=72042100, møbler af træ=94034010, elektronik=85xx, biler/bildele=87xx',
      '  * Marker gættede koder med ? foran: ?76020000',
      '  * KUN skip varelinjer hvis beskrivelsen er blank eller åbenlyst ikke en vare (fx "Fragt", "Shipping")',
      '- bruttovægt: LINJENS EGEN bruttovægt i kg. KUN udfyld hvis kolonnen eksplicit hedder "Brutto", "Brutto Vægt", "Gross weight", "Brt." eller lignende. ALDRIG udfyld dette felt fra en kolonne der hedder "Net W", "Net Weight", "Netto" — det er nettovægt, ikke brutto. Skriv 0 hvis kolonnen ikke findes eller er tvetydig.',
      '- nettovægt: LINJENS EGEN nettovægt i kg. Udfyld hvis kolonnen eksplicit hedder "Net W(kg)", "Net Weight", "Nettovægt", "Netto", "Nt." eller lignende. På fakturaer hvor der KUN er én vægtkolonne uden tydelig label er det oftest nettovægt — udfyld da dette felt. Skriv 0 hvis ingen vægt findes pr. linje.',
      '  * ENHED-TJEK: Hvis tallet i en vægt-kolonne efterfølges af en IKKE-VÆGT enhed som "m", "STK", "PCS", "und", "PALLET", "PALLE", "M", "M2", "ROL", "RL" — så er det QUANTITY, ikke en vægt. Det gælder selvom kolonne-headeren ligner "Net W(kg)". Eksempel: "2,012.000 m" betyder 2012 meter (længde), ikke 2012 kg. I så fald: skriv 0 i nettovægt for linjen og put tallet i antal-feltet i stedet. Kun enheder som "kg", "KG", "g", "Kg" bekræfter at det ER en vægt.',
      '  * SANITY-TJEK mod header: Hvis fakturaen har en total nettovægt i header-teksten (fx "NETTOVÆGT: 163,00 KG", "Net weight: X", "Nt. vægt: X"), så MÅ summen af alle dine pr-linje nettovægte IKKE overstige denne total (tillad op til 10% margin for afrunding). Hvis sum > total × 1,1, har du læst en eller flere linjers vægt forkert — sandsynligvis er det quantity (meter/stk) du har misforstået som vægt. Skriv 0 i nettovægt for de mistænkelige linjer og lad header-totalen fordele.',
      '- VIGTIGT om vægt-talformat:',
      '  * I europæiske/tyske fakturaer er punktum tusindtals og komma decimal: "2.800,000 KG" = 2800 kg',
      '  * I engelske fakturaer er komma tusindtals og punktum decimal: "2,800.000 KG" = 2800 kg',
      '  * VIGTIGST om tvetydige tal: Et fakturasprog (engelsk/tysk) bestemmer IKKE nødvendigvis talformatet — et engelsk firma kan udstede fakturaer i europæisk format. Når et vægttal kun har ÉN separator (fx "15.800" med kun punktum) er det tvetydigt. For at afgøre formatet: find et ANDET tal i samme faktura der har BÅDE punktum OG komma (typisk et beløb som "120.015,00"). Det fastlægger formatet for HELE fakturaen, og du anvender det konsekvent på alle tal (vægt, antal, beløb). Eksempel: hvis fakturaen har beløbet "120.015,00 DKK" (punktum=tusind, komma=decimal), så er "Gross weight: 15.800 Kg" = 15800 kg (IKKE 15,8) og "Net weight: 15.000 KG" = 15000 kg. Ekstra tjek: hvis varen hedder fx "10KG ..." og antal er 1500, så er nettovægten 1500×10=15000 kg — det bekræfter at 15.000 betyder 15000.',
      '  * Hvis vægten er angivet i GRAM (g) - konverter til kg (fx 154 g = 0.154 kg)',
      '  * Hvis der kun er styk-vægt, gang med antal (fx 0.48 kg × 10 stk = 4.8 kg)',
      '  * ALDRIG brug den totale "Gross weight" eller "Total weight" fra forsiden/bundlinjen — kun pr. linje',
      '  * Hvis vægten KUN står som EN ENKELT FRITSTÅENDE TEKSTLINJE under eller efter varelinjerne (IKKE som en kolonne med kolonneoverskrift), så er det FAKTURAENS TOTAL — ikke pr. linje. Eksempler: "Vægt: 82 kg" stående under en kort vareliste, "Total vægt: X kg", eller "Brt. vægt: 308 kg" som én linje. I disse tilfælde: skriv 0 i BÅDE bruttovægt OG nettovægt for ALLE varelinjer fra den faktura, og læg vægten i header-feltet "Bruttovægt i alt (kg)" i stedet. Hvis flere fakturaer hver har en sådan fritstående vægt-linje, summer dem til ét tal i headeren.',
      '  * Konverter ALDRIG en vægt til mere end 10x den totale forsendelsevægt',
      '- antal: stykantal per varelinje. VIGTIGT: Skriv KUN antal hvis der er et tal i antal-kolonnen for denne linje. Skriv 0 hvis kolonnen er tom eller blank for denne linje. Se efter kolonner kaldet: Antal, PC, STK, PCS, Qty, Quantity, Stk. AUBO-fakturaer har en Antal kolonne - kun nogle linjer har antal udfyldt.',
      '- coo: oprindelsesland som det staar i dokumentet (kan vaere H, D, IND, VRC, PL, GB, NL, IL osv.) - skriv det PRAECIS som det staar, systemet konverterer automatisk til ISO kode. OBS: RL, PK, STK, PCS, KG, M, M2, PC er enheder NOT COO - skriv XX hvis du ikke kan finde et gyldigt oprindelsesland.',
      '- valuta: 3-bogstavs valutakode',
      '- beloeb: linjebeloeb som tal uden valutasymbol',
      '- fakturanr: fakturanummer for denne linje',
      '',
      'Eksempel 1 (AUBO med "Brutto Vægt"-kolonne, antal udfyldt): 17693|94034010|MOEBLER AF TRAE|9318|0|6|DK|NOK|696213.31',
      'Eksempel 2 (Euronete med "Net W(kg)"-kolonne — netto udfyldt, brutto=0): 22600302|56081120|NBT PREMIUM|0|297.5|0|PT|EUR|3254.65',
      'Eksempel 3 (Customs tariff number, ingen vægt pr. linje): 91690616|87089997|STS 2.0 VWCAM OS9|0|0|1|DE|EUR|120.92',
      'Eksempel 4 (AUBO - antal tom for denne linje, kolonne er Brutto): 17758|85166080|OVNE|205|0|0|DK|NOK|37090.00',
      'Eksempel 5 (Meyer/tysk - "Net Weight" kolonne): 29596|87083091|Brake pads BWD|0|3.85|25|IT|EUR|766.75',
      '',
      'Medtag ALLE varelinjer du kan finde hs_kode for.',
      'MEDTAG IKKE fragtlinjer og transportomkostninger uden hs_kode (fx Freight Expenses, LW EXP FREIGHT EXPENSES, Transport Charges, TRA) - disse er ikke tolddokumenterede varer.',
      'MEDTAG IKKE linjer fra Ausfuhrbegleitdokument (ABD) der har beloeb=0 OG fakturanummer der slutter på " FO" eller indeholder "ABD" OG har en beskrivelse der kombinerer mange varenavne med komma. Almindelige fakturalinjer med komma i beskrivelsen og beloeb>0 skal ALTID med.'
    ].join('\n');

    let headerData, alleLinjer = [];

    // Split PDF i chunks og kør header parallelt med første chunk
    const CHUNK_SIZE = 8;
    try {
      const pdfBytes = Buffer.from(b64, 'base64');
      const srcPdf = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
      const numPages = srcPdf.getPageCount();
      const numChunks = Math.ceil(numPages / CHUNK_SIZE);
      console.log('PDF: ' + numPages + ' sider, ' + numChunks + ' bidder af ' + CHUNK_SIZE);

      // Byg alle chunks på forhånd
      const chunks = [];
      for (let i = 0; i < numChunks; i++) {
        const fromPage = i * CHUNK_SIZE;
        const toPage = Math.min((i + 1) * CHUNK_SIZE, numPages);
        const chunkPdf = await PDFDocument.create();
        const indices = [];
        for (let p = fromPage; p < toPage; p++) indices.push(p);
        const copied = await chunkPdf.copyPages(srcPdf, indices);
        copied.forEach(page => chunkPdf.addPage(page));
        const chunkBytes = await chunkPdf.save();
        chunks.push({ b64: Buffer.from(chunkBytes).toString('base64'), from: fromPage+1, to: toPage });
      }

      // ═══════════════════════════════════════════════════════════════════════
      // TO-TRINS UDTRÆK — første trin opdager fakturanumre, andet trin udtrækker detaljer
      // Dette sikrer at vi altid fanger alle fakturaer, også i samlefakturaer med 3+ sider.
      // ═══════════════════════════════════════════════════════════════════════
      console.log('Trin 1: Opdager alle fakturaer i dokumentet...');
      const fakturaOpdagelsesPrompt = [
        'Du er toldspeditionsekspert. Læs hele dette dokument grundigt og find hvilke fakturaer det indeholder.',
        'Svar KUN med JSON, ingen markdown, ingen forklaring.',
        '',
        '═══════════════════════════════════════════════════════',
        'DER ER TO SCENARIER — AFGØR HVILKET FØR DU SVARER:',
        '═══════════════════════════════════════════════════════',
        '',
        'SCENARIE A — SAMLEFAKTURA (RETURNÉR KUN ÉT NUMMER)',
        'Hvis dokumentet er ÉN samlefaktura der opsummerer flere underliggende fakturaer:',
        '  - Overskrift eller øverste område viser "Samlefaktura", "Collective invoice", "Samle fakturanr.", "Summary invoice"',
        '  - Der er ÉT beløb for hele dokumentet i bunden',
        '  - Der står noget som "Omfatter følgende faktura: N123-N456" eller "Includes invoices: ..."',
        '  - De underliggende fakturaer vises KUN som en liste/opremsning, IKKE med deres egne hoveder',
        '',
        '  → RETURNÉR KUN det primære samlefaktura-nummer (det der står ved "Samle fakturanr.", "Summary invoice no.", "Collective no." osv.)',
        '  → IGNORÉR listen af underliggende fakturaer — de er ikke selvstændige fakturaer',
        '',
        '  Eksempel — AUBO samlefaktura:',
        '  Dokumentet har overskrift "Samlefaktura" + "Samle fakturanr. 17792"',
        '  + "Omfatter følgende faktura: N00224633-N00224659"',
        '  → SVAR: {"fakturanumre":["17792"]}  (IKKE 27 numre!)',
        '',
        'SCENARIE B — FLERE SELVSTÆNDIGE FAKTURAER',
        'Hvis dokumentet indeholder flere fulde fakturaer hver med sit eget hoved, dato, beløb osv.:',
        '  - Hver faktura har sin egen "Proforma Invoice: XXX" eller "Invoice: XXX" overskrift',
        '  - Hver faktura har sin egen dato, sit eget beløb, sin egen side',
        '  - Der er IKKE et samlet beløb på forsiden',
        '',
        '  → RETURNÉR ALLE fakturanumre',
        '',
        '  Eksempel — CASCOO-dokument med 3 proforma invoices:',
        '  → SVAR: {"fakturanumre":["2026-210742","2026-211460","2026-211035"]}',
        '',
        '═══════════════════════════════════════════════════════',
        'HVOR DU KIGGER EFTER FAKTURANUMRE:',
        '═══════════════════════════════════════════════════════',
        '- "Samle fakturanr.", "Collective invoice no.", "Summary invoice"',
        '- "Proforma Invoice:" efterfulgt af nummer',
        '- "Invoice:" eller "Invoice No.:" efterfulgt af nummer',
        '- "order number:" efterfulgt af nummer (PÅ selve fakturasiden, ikke i sidehoved)',
        '- "Faktura nr." eller "Fakturanummer:"',
        '- CMR-reference "INVOICE: xxx" eller "senders ref.: INVOICE: xxx"',
        '',
        'IGNORÉR disse (de er IKKE fakturanumre):',
        '- "debit reference", "debit number" (kundens interne reference)',
        '- EORI-nummer, VAT-nummer, CVR-nummer',
        '- "Tollkreditt", "Org. nr.", "SE-nummer"',
        '- Opremsning af underliggende fakturanumre i samlefaktura ("Omfatter følgende faktura: N00224633-N00224659")',
        '',
        'Format: {"fakturanumre":["nr1","nr2","nr3"]}'
      ].join('\n');

      let forventedeFakturanumre = [];
      try {
        const opdagelsesTekst = await callClaude(apiKey, b64, fakturaOpdagelsesPrompt, 500);
        const opdagelsesRens = opdagelsesTekst.split('```json').join('').split('```').join('').trim();
        const opdaget = JSON.parse(opdagelsesRens);
        if (Array.isArray(opdaget.fakturanumre)) {
          forventedeFakturanumre = opdaget.fakturanumre.filter(n => n && String(n).trim().length > 0);
        }
        console.log('Trin 1 fandt ' + forventedeFakturanumre.length + ' fakturanumre: ' + forventedeFakturanumre.join(', '));
      } catch(e) {
        console.log('Faktura-opdagelse fejlede (fortsætter uden):', e.message);
      }

      // Tilføj listen til header-prompten så Claude kender det eksakte antal
      const hPromptMedFakturaListe = forventedeFakturanumre.length > 0
        ? hPrompt + '\n\nVIGTIGT: Dokumentet indeholder PRÆCIS ' + forventedeFakturanumre.length +
          ' faktura(er) med disse numre: ' + forventedeFakturanumre.join(', ') +
          '. Du SKAL returnere nøjagtigt ' + forventedeFakturanumre.length +
          ' element(er) i fakturaer[]-arrayet, én for hvert af disse numre. For hver faktura skal du finde dens korrekte dato, beløb, og valuta.'
        : hPrompt;

      // Kør header og første chunk PARALLELT
      console.log('Trin 2: Starter header + chunk 1 parallelt...');
      const [headerTekst, chunk0Tekst] = await Promise.all([
        callClaude(apiKey, headerB64, hPromptMedFakturaListe, 4000),
        callClaude(apiKey, chunks[0].b64, vPrompt, 8000)
      ]);
      headerData = JSON.parse(headerTekst.split('```json').join('').split('```').join('').trim());
      console.log('Header OK, chunk 1 OK');
      console.log('Fakturaer udtrukket: ' + (headerData.fakturaer || []).length + ' (forventede: ' + forventedeFakturanumre.length + ')');
      console.log('MRN i header:', JSON.stringify(headerData.header && headerData.header['MRN']));

      // ═══════════════════════════════════════════════════════════════════════
      // SIKKERHEDSNET — hvis antal udtrukne fakturaer ikke matcher trin 1, prøv igen
      // Maksimalt 1 retry for at undgå uendelig løkke ved komplekse dokumenter
      // ═══════════════════════════════════════════════════════════════════════
      if (forventedeFakturanumre.length > 0 &&
          (headerData.fakturaer || []).length !== forventedeFakturanumre.length) {
        console.log('ADVARSEL: Antal fakturaer matcher ikke! Genforsøger med strengere prompt...');
        const strengePrompt = hPrompt +
          '\n\nKRITISK VIGTIGT: Dokumentet indeholder PRÆCIS ' + forventedeFakturanumre.length + ' fakturaer.' +
          '\nDisse numre SKAL alle medtages i fakturaer[]: ' + forventedeFakturanumre.join(', ') +
          '\nDu MÅ IKKE returnere færre end ' + forventedeFakturanumre.length + ' fakturaer.' +
          '\nFor hver faktura skal du finde dens egen dato, beløb og valuta — de er forskellige.' +
          '\nLæs HELE dokumentet igennem flere gange hvis nødvendigt for at finde alle ' + forventedeFakturanumre.length + ' fakturaer.';
        try {
          const retryTekst = await callClaude(apiKey, headerB64, strengePrompt, 4000);
          const retryData = JSON.parse(retryTekst.split('```json').join('').split('```').join('').trim());
          if ((retryData.fakturaer || []).length >= forventedeFakturanumre.length) {
            console.log('Retry lykkedes — bruger resultat fra retry');
            headerData = retryData;
          } else {
            console.log('Retry lykkedes ikke helt — supplerer manglende fakturaer fra trin 1 liste');
            // Byg en liste med alle forventede numre, udfyld hvad vi har fra udtræk
            const udtrukne = headerData.fakturaer || [];
            const udtrukneMap = {};
            udtrukne.forEach(f => { if (f.fakturanummer) udtrukneMap[f.fakturanummer] = f; });
            headerData.fakturaer = forventedeFakturanumre.map(nr =>
              udtrukneMap[nr] || { fakturanummer: nr, fakturadato: '', beloeb: '', valuta: '', vekselkurs: '' }
            );
            // Tilføj notat så brugeren ved at nogle fakturaer mangler detaljer
            const manglerDetaljer = forventedeFakturanumre.filter(nr => !udtrukneMap[nr]);
            if (manglerDetaljer.length > 0) {
              headerData.notes = (headerData.notes || '') +
                ' OBS: Følgende fakturaer blev fundet i dokumentet men mangler detaljer — tjek og udfyld manuelt: ' +
                manglerDetaljer.join(', ') + '.';
            }
          }
        } catch(e) {
          console.log('Retry fejlede:', e.message);
        }
      }
      // Fallback: hvis MRN-feltet er tomt, søg i notes med regex
      if (headerData.header && (!headerData.header['MRN'] || !headerData.header['MRN'].value)) {
        const mrnMatch = (headerData.notes || '').match(/\b(\d{2}[A-Z]{2}[A-Z0-9]{14,16})\b/);
        if (mrnMatch) {
          headerData.header['MRN'] = { value: mrnMatch[1], confidence: 'medium' };
          console.log('MRN fundet via fallback regex:', mrnMatch[1]);
        }
      }

      // Behandl chunk 0 resultater
      function parseChunk(tekst, label) {
        if (!tekst || !tekst.includes('|')) return;
        const linjer = tekst.trim().split('\n').filter(l => l.includes('|')).map(function(l) {
          const p = l.split('|');
          return {
            fakturanummer: (p[0]||'').trim(),
            hs_kode:       (p[1]||'').trim().replace(/^\?/, ''),
            gaettet:       (p[1]||'').trim().startsWith('?'),
            beskrivelse:   (p[2]||'').trim(),
            bruttovægt:    (p[3]||'').trim(),
            nettovægt:     (p[4]||'').trim(),
            antal:         (p[5]||'').trim(),
            coo:           (p[6]||'').trim(),
            valuta:        (p[7]||'').trim(),
            beloeb:        (p[8]||'').trim()
          };
        }).filter(function(l) { return l.hs_kode && l.hs_kode.replace(/^\?/,'').length >= 6; });

        // INGEN global dedup — samme vare kan optræde flere gange i samme faktura
        // (fx "2 × Tipi lærk" vises som to identiske linjer og begge skal med).
        // Kun ægte chunk-overlap filtreres fra: hvis chunk N indeholder alle de linjer som chunk N-1
        // allerede har bidraget med, er det klar overlapning og vi springer dem over.
        // Dette implementeres ved at lagre hver chunk's linjer separat og derefter sammenligne.
        linjer.forEach(l => alleLinjer.push(l));
        console.log(label + ': ' + linjer.length + ' linjer tilføjet, total: ' + alleLinjer.length);
      }
      parseChunk(chunk0Tekst, 'Chunk 1');

      // Kør resterende chunks sekventielt
      for (let i = 1; i < chunks.length; i++) {
        if (i > 1) await new Promise(r => setTimeout(r, 500));
        console.log('Chunk ' + (i+1) + '/' + numChunks + ': side ' + chunks[i].from + '-' + chunks[i].to);
        try {
          const tekst = await callClaude(apiKey, chunks[i].b64, vPrompt, 8000);
          parseChunk(tekst, 'Chunk ' + (i+1));
        } catch(e) { console.log('Chunk ' + (i+1) + ' fejl: ' + e.message); }
      }
    } catch(pdfErr) {
      // Fallback: send hele PDF hvis split fejler
      console.log('PDF split fejl, sender hel PDF:', pdfErr.message);
      try {
        // Header og varelinjer parallelt i fallback
        const [hTekst, vTekst] = await Promise.all([
          headerData ? Promise.resolve(null) : callClaude(apiKey, headerB64, hPrompt, 4000),
          callClaude(apiKey, b64, vPrompt, 8000)
        ]);
        if (!headerData && hTekst) {
          headerData = JSON.parse(hTekst.split('```json').join('').split('```').join('').trim());
        }
        const tekst = vTekst;
        if (tekst && tekst.includes('|')) {
          alleLinjer = tekst.trim().split('\n').filter(l => l.includes('|')).map(function(l) {
            const p = l.split('|');
            return {
              fakturanummer: (p[0]||'').trim(), hs_kode: (p[1]||'').trim(),
              beskrivelse: (p[2]||'').trim(),
              bruttovægt: (p[3]||'').trim(), nettovægt: (p[4]||'').trim(),
              antal: (p[5]||'').trim(), coo: (p[6]||'').trim(),
              valuta: (p[7]||'').trim(), beloeb: (p[8]||'').trim()
            };
          }).filter(function(l) { return l.hs_kode && l.hs_kode.length >= 6; });
        }
      } catch(e2) { console.log('Fallback fejl:', e2.message); }
    }

    console.log('Faerdig. Total: ' + alleLinjer.length + ' unikke linjer');
    res.json({
      doc_type:   headerData.doc_type || 'Handelsfaktura',
      header:     headerData.header || {},
      fakturaer:  headerData.fakturaer || [],
      varelinjer: alleLinjer,
      notes:      headerData.notes || ''
    });

  } catch(err) {
    console.error('Fejl:', err.message);
    res.status(500).json({ error: err.message });
  }
});


// XML eksport — direkte fil-download via Content-Disposition: attachment
app.post('/api/export-xml', function(req, res) {
  try {
    let data = req.body;
    if (data && data.data && typeof data.data === 'string') {
      try { data = JSON.parse(data.data); } catch(e) {}
    }
    if (!data || !data.header) return res.status(400).send('Ingen data');

    const type      = req.body.type   || 'import';
    const module    = req.body.module || 'DK';
    const mrn       = req.body.mrn    || '';
    const transport = req.body.transport ? JSON.parse(req.body.transport) : null;
    const dryRun    = req.body.dryRun === '1' || req.body.dryRun === 'true';
    const xml       = buildEmmaXML(data, module, type, mrn, transport);
    const refRaw = (data.header['Afregningsreference'] && data.header['Afregningsreference'].value)
                 ? data.header['Afregningsreference'].value.trim() : 'tolddata';
    const ref = sanitizeRef(refRaw);

    // Filnavn: ref_DK_EX_emma.xml eller ref_NO_IM_emma.xml
    const typeKode = type === 'export' ? 'EX' : 'IM';
    const filename = ref + '_' + module + '_' + typeKode + '_emma.xml';

    res.setHeader('Content-Type', 'text/xml; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
    res.setHeader('Content-Length', Buffer.byteLength(xml, 'utf8'));
    res.send(xml);
    console.log('XML sendt: ' + filename + ' (' + Buffer.byteLength(xml,'utf8') + ' bytes)');
    // SFTP-upload deaktiveret 28/4-2026 — DigitalOcean-server afmeldt.
    // Lokal-gem via "Gem til Emma-mapper" (File System Access API) er den primære vej.
    // if (!dryRun) {
    //   uploadToSftp(xml, filename, module).then(ok => {
    //     if (ok) console.log('SFTP OK: ' + filename);
    //     else console.log('SFTP fejlede (filen er stadig downloadet): ' + filename);
    //   });
    // }
  } catch(err) {
    console.error('XML fejl:', err.message);
    res.status(500).send('Fejl: ' + err.message);
  }
});

// ─── Manuel godkendelse af pending XML ────────────────────────────────────────
function htmlSide(title, bodyHtml) {
  return `<!DOCTYPE html><html lang="da"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:640px;margin:40px auto;padding:0 20px;color:#1a1a1a;line-height:1.5}
  .card{background:#fff;border:1px solid #e5e5e5;border-radius:10px;padding:24px;box-shadow:0 1px 3px rgba(0,0,0,0.05)}
  table{border-collapse:collapse;width:100%;margin:16px 0}
  td{padding:6px 0;vertical-align:top}
  td.label{color:#666;width:160px}
  .btn{display:inline-block;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:bold;font-size:15px;border:none;cursor:pointer;font-family:inherit}
  .btn-green{background:#16a34a;color:white}
  .btn-red{background:#dc2626;color:white}
  .btn-gray{background:#6b7280;color:white}
  h1{margin-top:0}
  code{background:#f3f4f6;padding:2px 6px;border-radius:3px;font-size:13px}
  .success-banner{background:#dcfce7;border:2px solid #16a34a;padding:16px;border-radius:8px;margin-bottom:20px}
  .reject-banner{background:#fee2e2;border:2px solid #dc2626;padding:16px;border-radius:8px;margin-bottom:20px}
  .warn-banner{background:#fef3c7;border:2px solid #f59e0b;padding:16px;border-radius:8px;margin-bottom:20px}
</style></head><body><div class="card">${bodyHtml}</div></body></html>`;
}

function pendingOverview(p) {
  const xmlListe = p.xmls.map(x => `<li><code>${x.filename}</code></li>`).join('');
  const t = p.transport || {};
  return `
    <table>
      <tr><td class="label">Kunde</td><td><b>${p.kundeNavn}</b></td></tr>
      <tr><td class="label">Reference</td><td><b>${p.ref}</b></td></tr>
      <tr><td class="label">Afsender email</td><td>${p.afsenderMail || '—'}</td></tr>
      <tr><td class="label">Emne</td><td>${p.emne || '—'}</td></tr>
      <tr><td class="label">PDF'er</td><td>${p.pdfNames.join(', ')}</td></tr>
      <tr><td class="label">Varelinjer</td><td>${p.varelinjerAntal}</td></tr>
      <tr><td class="label">Transport</td><td>${t.bilnr || '—'} | ${t.faerge || '—'} | ${t.rute || '—'}</td></tr>
      <tr><td class="label">Dato</td><td>${t.dato || '—'}</td></tr>
    </table>
    <h3>XML-filer der uploades:</h3>
    <ul>${xmlListe}</ul>
  `;
}

// GET /api/godkend/:id — vis bekræftelsesside (ingen upload endnu)
app.get('/api/godkend/:id', (req, res) => {
  const p = getPending(req.params.id);
  if (!p) {
    return res.status(404).send(htmlSide('Ikke fundet', `
      <div class="warn-banner"><h1 style="margin:0">Godkendelse ikke fundet</h1></div>
      <p>Dette link er allerede brugt, afvist, eller udløbet (links gælder i 24 timer).</p>
      <p>Hvis du stadig vil sende til Emma, bed kunden om at genfremsende fakturaen til post@cwcs.dk.</p>
    `));
  }
  // Ukendte kunder TVINGES til at gå via Gennemse (ikke direkte godkend)
  if (p.erUkendtKunde) {
    const gennemseLink = `/?pending=${req.params.id}`;
    return res.send(htmlSide('Gennemse påkrævet', `
      <div class="warn-banner" style="background:#fef2f2;border:2px solid #dc2626;padding:14px 18px;border-radius:8px;color:#7f1d1d">
        <h1 style="margin:0;color:#991b1b">🚨 Ukendt kunde — Gennemse påkrævet</h1>
      </div>
      <p>Afsenderen <b>${p.afsenderMail || p.kundeNavn}</b> er ikke på whitelisten. Claude har gættet moduler, toldsteder og transport ud fra mailen og PDF'en.</p>
      <p>Fordi der er risiko for fejltolkning, skal du gennemse og verificere data før godkendelse. "Godkend direkte" er ikke tilgængeligt for ukendte kunder.</p>
      <div style="margin-top:24px;text-align:center">
        <a href="${gennemseLink}" class="btn btn-green">🔍 Gå til Gennemse</a>
        <a href="/api/afvis/${req.params.id}" class="btn btn-gray" style="margin-left:8px">Afvis</a>
      </div>
    `));
  }
  res.send(htmlSide('Bekræft godkendelse', `
    <h1>Bekræft godkendelse</h1>
    <p>Du er ved at <b>sende ${p.xmls.length} XML-fil(er) til Emma</b> som vil indsende en tolddeklaration til Tolden.</p>
    ${pendingOverview(p)}
    <form method="POST" action="/api/godkend/${req.params.id}/bekraeft" style="margin-top:28px;text-align:center">
      <button type="submit" class="btn btn-green">✅ Ja, send til Emma nu</button>
      <a href="/api/afvis/${req.params.id}" class="btn btn-gray" style="margin-left:8px">Fortryd</a>
    </form>
  `));
});

// POST /api/godkend/:id/bekraeft — UPLOAD til SFTP (evt. med redigerede data fra UI)
app.post('/api/godkend/:id/bekraeft', async (req, res) => {
  const p = getPending(req.params.id);
  if (!p) {
    return res.status(404).send(htmlSide('Ikke fundet', `
      <div class="warn-banner"><h1 style="margin:0">Ikke fundet</h1></div>
      <p>Godkendelsen er ikke længere gyldig.</p>
    `));
  }

  // Hvis request body indeholder 'data' (JSON fra UI med evt. rettelser)
  // genbygger vi XML fra de opdaterede data. Ellers bruger vi den gemte XML.
  let xmlListe = p.xmls;
  const erJson = req.is('application/json');
  if (erJson && req.body && req.body.data) {
    try {
      const opdaterdeData = req.body.data;
      // Brug transport fra UI'en hvis sendt med, ellers den gemte config
      const brugtTransport = req.body.transport || p.transportObj;
      console.log('[Godkend] Bruger transport:', JSON.stringify(brugtTransport));
      xmlListe = [];
      for (const modul of p.moduler) {
        const [mod, typeKode] = modul.split('_');
        const type = typeKode === 'EX' ? 'export' : 'import';
        const xml = buildEmmaXML(opdaterdeData, mod, type, '', brugtTransport);
        const ref = (opdaterdeData.header['Afregningsreference'] && opdaterdeData.header['Afregningsreference'].value)
                  ? opdaterdeData.header['Afregningsreference'].value.trim() : 'tolddata';
        const filename = ref + '_' + mod + '_' + typeKode + '_emma.xml';
        xmlListe.push({
          filename,
          xmlBase64: Buffer.from(xml, 'utf8').toString('base64'),
          module: mod
        });
      }
      console.log('[Godkend] XML genbygget fra redigerede data — ' + xmlListe.length + ' fil(er)');
    } catch(e) {
      console.error('[Godkend] Fejl ved genbygning af XML:', e.message);
      if (erJson) return res.status(500).json({ ok: false, fejl: e.message });
      return res.status(500).send(htmlSide('Fejl', `<h1>Fejl</h1><p>${e.message}</p>`));
    }
  }

  const resultater = [];
  for (const x of xmlListe) {
    const xmlTekst = Buffer.from(x.xmlBase64, 'base64').toString('utf8');
    const ok = await uploadToSftp(xmlTekst, x.filename, x.module);
    resultater.push({ filename: x.filename, ok });
    console.log(`[Godkend] ${x.filename} SFTP ${ok ? 'OK' : 'FEJL'} — ref ${p.ref}`);
  }
  deletePending(req.params.id);

  const alleOk = resultater.every(r => r.ok);

  // Hvis JSON request → svar med JSON
  if (erJson) {
    return res.json({ ok: alleOk, resultater, ref: p.ref });
  }

  // Ellers → HTML side
  const listeHtml = resultater.map(r => `<li style="color:${r.ok?'#16a34a':'#dc2626'}">${r.ok?'✅':'❌'} <code>${r.filename}</code></li>`).join('');
  res.send(htmlSide(alleOk ? 'Sendt til Emma' : 'Delvist sendt', `
    <div class="${alleOk?'success-banner':'reject-banner'}">
      <h1 style="margin:0">${alleOk ? '✅ Sendt til Emma' : '⚠️ Fejl ved upload'}</h1>
      <p style="margin:8px 0 0 0">${alleOk ? `${resultater.length} XML-fil(er) uploadet til SFTP. Emma henter dem automatisk.` : 'Nogle filer blev ikke uploadet. Tjek Render-loggen.'}</p>
    </div>
    <ul>${listeHtml}</ul>
    <p><b>Reference:</b> ${p.ref}<br><b>Kunde:</b> ${p.kundeNavn}</p>
    <p style="color:#666;font-size:13px;margin-top:24px">Du kan lukke denne fane.</p>
  `));
});

// GET /api/afvis/:id — vis bekræftelsesside for afvisning
app.get('/api/afvis/:id', (req, res) => {
  const p = getPending(req.params.id);
  if (!p) {
    return res.status(404).send(htmlSide('Ikke fundet', `
      <div class="warn-banner"><h1 style="margin:0">Ikke fundet</h1></div>
      <p>Dette link er allerede brugt eller udløbet.</p>
    `));
  }
  res.send(htmlSide('Bekræft afvisning', `
    <h1>Bekræft afvisning</h1>
    <p>Du er ved at afvise denne tolddeklaration. <b>Intet bliver sendt til Emma.</b></p>
    ${pendingOverview(p)}
    <form method="POST" action="/api/afvis/${req.params.id}/bekraeft" style="margin-top:28px;text-align:center">
      <button type="submit" class="btn btn-red">❌ Ja, afvis</button>
      <a href="/api/godkend/${req.params.id}" class="btn btn-gray" style="margin-left:8px">Fortryd</a>
    </form>
  `));
});

// POST /api/afvis/:id/bekraeft — slet fra pending
app.post('/api/afvis/:id/bekraeft', (req, res) => {
  const p = getPending(req.params.id);
  if (!p) {
    return res.status(404).send(htmlSide('Ikke fundet', `<h1>Ikke fundet</h1>`));
  }
  deletePending(req.params.id);
  console.log(`[Godkend] AFVIST — ref ${p.ref}`);
  res.send(htmlSide('Afvist', `
    <div class="reject-banner">
      <h1 style="margin:0">❌ Afvist</h1>
      <p style="margin:8px 0 0 0">Tolddeklarationen er IKKE sendt til Emma. Ingenting er uploadet.</p>
    </div>
    <p><b>Reference:</b> ${p.ref}<br><b>Kunde:</b> ${p.kundeNavn}</p>
    <p style="color:#666;font-size:13px;margin-top:24px">Du kan lukke denne fane.</p>
  `));
});

// GET /api/pending — simpel oversigt over ventende godkendelser (intern)
app.get('/api/pending', (req, res) => {
  res.json({ pending: listPending() });
});

// GET /api/pending-data/:id — hent data til UI for at vise og redigere
app.get('/api/pending-data/:id', (req, res) => {
  const p = getPending(req.params.id);
  if (!p) return res.status(404).json({ error: 'Godkendelse ikke fundet eller udløbet' });
  res.json({
    data: p.extractedData,
    moduler: p.moduler,
    alleModulerTilladt: p.alleModulerTilladt,
    ref: p.ref,
    kundeNavn: p.kundeNavn,
    afsenderMail: p.afsenderMail,
    emne: p.emne,
    mailTekst: p.mailTekst || '',
    mailInfo: p.mailInfo || {},
    pdfNames: p.pdfNames,
    transportObj: p.transportObj,
    erUkendtKunde: p.erUkendtKunde || false,
    oprettet: new Date(p.createdAt).toISOString()
  });
});

// POST /api/afvis/:id/bekraeft fra JSON (UI call)
app.post('/api/afvis/:id/json', (req, res) => {
  const p = getPending(req.params.id);
  if (!p) return res.status(404).json({ ok: false, fejl: 'Ikke fundet' });
  deletePending(req.params.id);
  console.log(`[Godkend] AFVIST via UI — ref ${p.ref}`);
  res.json({ ok: true, ref: p.ref });
});

// Excel varelinjer eksport til Emma indlæsning
import { execFile } from 'child_process';
import { writeFileSync, readFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

app.post('/api/export-excel', function(req, res) {
  try {
    let data = req.body;
    if (data && data.data && typeof data.data === 'string') {
      try { data = JSON.parse(data.data); } catch(e) {} 
    }
    if (!data || !data.header) return res.status(400).send('Ingen data');

    const type   = req.body.type   || 'export';
    const module = req.body.module || 'NO';
    const moduleCode = module + '_' + (type === 'export' ? 'EX' : 'IM');
    const refRaw = (data.header['Afregningsreference'] && data.header['Afregningsreference'].value)
                 ? data.header['Afregningsreference'].value.trim() : 'tolddata';
    const ref = sanitizeRef(refRaw);

    const tmpOut = join(tmpdir(), ref + '_' + moduleCode + '_emma.xlsx');
    const tmpJson = join(tmpdir(), ref + '_' + moduleCode + '_data.json');
    const scriptPath = join(__dirname, 'gen_emma_excel.py');

    writeFileSync(tmpJson, JSON.stringify(data), 'utf8');
    execFile('python3', [scriptPath, tmpJson, moduleCode, tmpOut], (err, stdout, stderr) => {
      try { unlinkSync(tmpJson); } catch(e) {}
      if (err) {
        console.error('Excel fejl:', err.message, stderr);
        return res.status(500).send('Excel fejl: ' + err.message);
      }
      const fileBuffer = readFileSync(tmpOut);
      try { unlinkSync(tmpOut); } catch(e) {}
      const filename = ref + '_' + moduleCode + '_emma.xlsx';
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
      res.setHeader('Content-Length', fileBuffer.length);
      res.send(fileBuffer);
      console.log('Excel sendt: ' + filename);
    });
  } catch(err) {
    console.error('Excel fejl:', err.message);
    res.status(500).send('Fejl: ' + err.message);
  }
});

// ─── Mail agent test endpoint ─────────────────────────────────────────────────
app.get('/api/test-mailagent', async (req, res) => {
  const result = await testMailAgent();
  res.json(result);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, function() {
  console.log('Server koerer paa port ' + PORT);
  // Start mail agent
  startMailAgent().catch(err => console.error('Mail agent start fejl:', err.message));
});
