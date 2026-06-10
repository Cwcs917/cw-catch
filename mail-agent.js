import fetch from 'node-fetch';
import crypto from 'crypto';

// ─── Konfiguration ────────────────────────────────────────────────────────────
const GRAPH_TOKEN_URL = `https://login.microsoftonline.com/${process.env.MS_TENANT_ID}/oauth2/v2.0/token`;
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const MAILBOX = 'post@cwcs.dk';
const CHECK_INTERVAL_MS = 2 * 60 * 1000; // 2 minutter
const PUBLIC_URL = process.env.PUBLIC_URL || 'https://tolddata.onrender.com';

// Whitelist — domæne ELLER fuld email-adresse → konfiguration
// manualApproval: true → agent genererer XML og sender godkendelsesmail, men uploader IKKE til SFTP før du klikker Godkend
const WHITELIST = {
  'aubo.dk': {
    navn: 'AUBO Production A/S',
    moduler: ['DK_EX', 'NO_IM'],
    toldsted: 'DK003102',      // Hirtshals
    exitToldsted: 'DK003102',  // Hirtshals (sejler direkte)
    erBaad: true,
    manualApproval: true       // ← Kræver din godkendelse før SFTP upload
  },

  'toplogistik.com': {
    navn: 'Top Logistik',
    moduler: ['NO_EX'],
    kundenummer: '3',          // Ordregiver/klientnummer i Emma
    customsCode: '3770',       // Default udgangstoldsted (Svinesund svensk side) — redigerbart i UI
    defaultBorderNat: 'PL',    // Polske lastbiler via Fautra UAB — bruges hvis mail ikke siger andet
    erBaad: false,             // Altid landtransport
    manualApproval: true
  },

  // ─── TEST-ENTRY — Send fra cw@cwcs.dk for at teste flowet ────────────
  // Sat til AUBO-profil (DK_EX + NO_IM, Hirtshals, sejler).
  // Hvis du senere vil teste en anden kundes flow fra cw@cwcs.dk,
  // midlertidigt erstat felterne nedenfor med den pågældende kundes config.
  'cw@cwcs.dk': {
    navn: 'TEST — AUBO (via cw@cwcs.dk)',
    moduler: ['DK_EX', 'NO_IM'],
    toldsted: 'DK003102',
    exitToldsted: 'DK003102',
    erBaad: true,
    manualApproval: true
  }
};

// ─── Pending approvals store (in-memory) ──────────────────────────────────────
// Ved restart af serveren tabes afventende godkendelser — kunden skal genfremsende mail.
// Acceptabel afvejning for simplicitet. Udløber automatisk efter 24 timer.
const pendingApprovals = new Map();
const PENDING_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function nytTokenId() {
  return crypto.randomBytes(16).toString('hex');
}

function erUdloebet(p) {
  return Date.now() - p.createdAt > PENDING_MAX_AGE_MS;
}

export function getPending(id) {
  const p = pendingApprovals.get(id);
  if (!p || erUdloebet(p)) {
    if (p) pendingApprovals.delete(id);
    return null;
  }
  return p;
}

export function deletePending(id) {
  return pendingApprovals.delete(id);
}

export function listPending() {
  const liste = [];
  for (const [id, p] of pendingApprovals) {
    if (!erUdloebet(p)) {
      liste.push({
        id,
        ref: p.ref,
        kunde: p.kundeNavn,
        oprettet: new Date(p.createdAt).toISOString(),
        antalXml: p.xmls.length
      });
    }
  }
  return liste;
}

// Ryd udløbne hver time
setInterval(() => {
  for (const [id, p] of pendingApprovals) {
    if (erUdloebet(p)) pendingApprovals.delete(id);
  }
}, 60 * 60 * 1000);

// ─── Microsoft Graph auth ─────────────────────────────────────────────────────
let cachedToken = null;
let tokenExpiry = 0;

async function getGraphToken() {
  if (cachedToken && Date.now() < tokenExpiry - 60000) return cachedToken;
  const resp = await fetch(GRAPH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.MS_CLIENT_ID,
      client_secret: process.env.MS_CLIENT_SECRET,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials'
    })
  });
  const data = await resp.json();
  if (!data.access_token) throw new Error('Graph token fejl: ' + JSON.stringify(data));
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in * 1000);
  return cachedToken;
}

async function graphGet(path) {
  const token = await getGraphToken();
  const resp = await fetch(GRAPH_BASE + path, {
    headers: { Authorization: 'Bearer ' + token }
  });
  if (!resp.ok) throw new Error('Graph GET fejl ' + resp.status + ': ' + path);
  return resp.json();
}

async function graphPatch(path, body) {
  const token = await getGraphToken();
  const resp = await fetch(GRAPH_BASE + path, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!resp.ok) throw new Error('Graph PATCH fejl ' + resp.status);
}

async function sendMail(to, subject, body, attachments) {
  const token = await getGraphToken();
  const message = {
    subject,
    body: { contentType: 'HTML', content: body },
    toRecipients: [{ emailAddress: { address: to } }]
  };
  if (attachments && attachments.length > 0) {
    message.attachments = attachments.map(att => ({
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: att.filename,
      contentType: 'text/xml',
      contentBytes: att.xmlBase64
    }));
  }
  await fetch(GRAPH_BASE + `/users/${MAILBOX}/sendMail`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message })
  });
}

// ─── Udtræk transportinfo og instruktioner fra mailtekst via Claude ─────────
// Sender brødteksten til Claude API og får struktureret JSON tilbage.
// Falder tilbage til regex hvis Claude kaldet fejler.
async function udtraekMailInfo(tekst, kundeConfig) {
  // Hvis ingen API-nøgle: brug regex-fallback
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || !tekst || tekst.trim().length < 10) {
    return udtraekTransportRegex(tekst);
  }

  const prompt = [
    'Analyser denne mail fra en speditionskunde og udtræk transport-info + instruktioner.',
    'Svar KUN med gyldig JSON, ingen markdown, ingen forklaring.',
    '',
    'Format:',
    '{',
    '  "bilnr": "",                    // registreringsnummer, fx "MPI66","BSE69TU","NSD018" — tom hvis sejler direkte',
    '  "bilNationalitet": "",          // 2-bogstavs landekode for bil, fx "DK","NO","LT","PL","SE","DE","NL","AT" — tom hvis ikke nævnt',
    '  "skibsnr": "",                  // skibssagsnummer hvis sejler, fx "CG62858"',
    '  "chauffor": "",                 // chaufførnavn hvis nævnt',
    '  "dato": "",                     // dato for transport, format YYYY-MM-DD — tom hvis ikke nævnt',
    '  "sagsreference": "",            // Sags-/Reference-ID fra mailen, fx "FT2624387" — oftest efter "REF:", "Sagsnr:", "Ref:", "Reference:". IKKE fra PDF.',
    '  "opstartsToldsted": "",         // dansk toldstedskode hvis nævnt, fx "DK003102" eller "DK005604"',
    '  "udgangsToldsted": "",          // udgangstoldsted hvis køres gennem Sverige, fx "SE060340" (Svinesund), "SE060341" (Ørje), "SE603360" (Eda)',
    '  "noExCustomsCode": "",          // KUN for NO eksport: 4-cifret kode som "3770" (Svinesund), "3776" (Hån), "3778" (Eda)',
    '  "erBaad": false,                // true hvis bilen sejler direkte fra DK-havn (Hirtshals, Frederikshavn, Esbjerg osv.) til NO',
    '  "koererViaSverige": false,      // true hvis bilen kører gennem Sverige for at komme til Norge',
    '  "moduler": [],                  // liste af moduler nævnt: "DK_EX" (dansk eksport), "DK_IM" (dansk import), "NO_EX" (norsk eksport), "NO_IM" (norsk import/fortoldning)',
    '  "specielleInstruktioner": "",   // kort resumé af særlige instruktioner — "haster", "send kopi til X", MRN-dokument ønskes, andre vigtige noter',
    '  "konfidens": "hoej"             // "hoej", "mid", eller "lav" — hvor sikker er du på at du har fanget info korrekt?',
    '}',
    '',
    'Regler:',
    '- "Dansk eksport" / "DK eksport" / "udførselsangivelse" = DK_EX',
    '- "Norsk fortoldning" / "NO import" / "innfortolling" / "fortoldning" (når varer kommer ind i NO) = NO_IM',
    '- "Dansk import" / "fortoldning i DK" = DK_IM',
    '- "Norsk eksport" / "NO export" / når varer sendes UD af Norge = NO_EX',
    '- Hvis mailen nævner færge, båd, Color Line, Fjordline, Stena, BCF, sejler, havn → erBaad = true',
    '- Hvis mailen nævner Svinesund, Ørje, Eda, Charlottenberg, "via Sverige" → koererViaSverige = true og udgangsToldsted sættes',
    '- "trucknumber:", "Truck:", "Bil:", "Bilnr:" → bilnr',
    '- "REF:", "Sagsnr:", "Ref:", "Reference:" på egen linje eller med tal efter → sagsreference',
    '- Bilnummer-præfiks giver hint om nationalitet: WZ/MPI/KR/POL=PL, NSD kan være PL, LT/KLV=LT, A/AT=AT, N/NO=NO, D/DE=DE osv. Hvis tvivl, lad feltet være tom.',
    '- Hvis opstartsToldsted ikke er eksplicit nævnt, lad det være tomt — godkender vælger default',
    '- Korte simple mails ("trucknumber NSD233 REF: FT2624371") er OK og skal give konfidens "hoej" hvis bilnr + reference er fundet',
    '- Vær konservativ: hvis du er i tvivl, sæt tom streng i stedet for at gætte — og konfidens = "lav"',
    '',
    'Kunde: ' + (kundeConfig?.navn || 'ukendt') + ' (default moduler: ' + (kundeConfig?.moduler || []).join(',') + ')',
    '',
    'Mail-tekst:',
    '"""',
    tekst.substring(0, 3000), // Cap ved 3000 tegn for at undgå token-explosion
    '"""'
  ].join('\n');

  try {
    // Mail-analyse kører på Claude Sonnet 4.5 — samme model som PDF-udtrækket.
    // Kvalitet er vigtigere end den lille besparelse ved Haiku:
    // en enkelt mis-tolket mail koster mere at rette op på end et helt års besparelse.
    // Kan overskrives med env-variabel CLAUDE_MAIL_MODEL hvis man senere vil teste andre modeller.
    const mailModel = process.env.CLAUDE_MAIL_MODEL || 'claude-sonnet-4-5-20250929';
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: mailModel,
        max_tokens: 800,
        temperature: 0,  // Deterministisk — samme mail skal læses ens hver gang
        messages: [{ role: 'user', content: prompt }]
      })
    });
    const data = await resp.json();
    if (!data.content || !data.content[0]?.text) {
      console.warn('[Agent] Claude mail-analyse: uventet svar, bruger regex-fallback');
      return udtraekTransportRegex(tekst);
    }
    const raw = data.content[0].text.trim()
      .replace(/^```json\s*/i, '')
      .replace(/```\s*$/, '')
      .trim();
    const parsed = JSON.parse(raw);
    console.log('[Agent] Mail-analyse (' + mailModel + ', konfidens: ' + (parsed.konfidens || 'ukendt') + '):', JSON.stringify(parsed));
    return parsed;
  } catch(e) {
    console.warn('[Agent] Claude mail-analyse fejlede, bruger regex-fallback:', e.message);
    return udtraekTransportRegex(tekst);
  }
}

// Regex-fallback (gamle udtraekTransport omdøbt)
function udtraekTransportRegex(tekst) {
  const info = {
    bilnr: '', bilNationalitet: '', skibsnr: '', chauffor: '', dato: '',
    opstartsToldsted: '', udgangsToldsted: '',
    erBaad: false, koererViaSverige: false,
    moduler: [], specielleInstruktioner: '', konfidens: 'lav'
  };
  if (!tekst) return info;

  const bilMatch = tekst.match(/[Bb]il\s*(?:nr\.?|nummer)?[:\s]+([A-Z]{1,3}\s*\d{4,6}|[A-Z0-9]{5,10})/);
  if (bilMatch) info.bilnr = bilMatch[1].trim().replace(/\s+/g, '');

  const chaufMatch = tekst.match(/[Cc]hauff[øe]r[:\s]+(\w+)/);
  if (chaufMatch) info.chauffor = chaufMatch[1].trim();

  const datoMatch = tekst.match(/[Dd]ato[:\s]+.+?(\d{1,2}\/\d{1,2}[-–]\d{2,4})/);
  if (datoMatch) {
    const d = datoMatch[1].replace('–', '-');
    const parts = d.split(/[\/\-]/);
    if (parts.length >= 2) {
      const dag = parts[0].padStart(2, '0');
      const mdr = parts[1].padStart(2, '0');
      const aar = parts[2] ? (parts[2].length === 2 ? '20' + parts[2] : parts[2]) : new Date().getFullYear().toString();
      info.dato = aar + '-' + mdr + '-' + dag;
    }
  }

  info.erBaad = /[Ff]ærge|[Ff]erge|[Ff]jordline|[Cc]olor\s*[Ll]ine|[Ss]tena|[Cc]ristos|[Bb]CF/i.test(tekst);

  return info;
}

// ─── Behandl én mail ──────────────────────────────────────────────────────────
async function behandlMail(mail, kundeConfig) {
  const mailId = mail.id;
  const subject = mail.subject || '';
  const fra = mail.from?.emailAddress?.address || '';
  console.log(`[Agent] Behandler mail fra ${fra}: "${subject}"`);

  // Hent body og vedhæftninger
  const detaljer = await graphGet(`/users/${MAILBOX}/messages/${mailId}?$expand=attachments`);
  const bodyTekst = detaljer.body?.content?.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ') || '';

  // Analysér mailteksten med Claude — bilnr, dato, toldsteder, moduler, instruktioner
  const mailInfo = await udtraekMailInfo(bodyTekst, kundeConfig);
  console.log('[Agent] Mail-info udtrukket: konfidens=' + (mailInfo.konfidens || '?') +
              ', moduler=' + (mailInfo.moduler || []).join(',') +
              ', erBaad=' + mailInfo.erBaad);

  // Find PDF-vedhæftninger
  const pdfs = (detaljer.attachments || []).filter(a =>
    a['@odata.type'] === '#microsoft.graph.fileAttachment' &&
    (a.name?.toLowerCase().endsWith('.pdf') || a.contentType === 'application/pdf')
  );

  if (pdfs.length === 0) {
    console.log('[Agent] Ingen PDF-vedhæftninger — markerer som behandlet (intet at gøre)');
    await markerMail(mailId, mail.categories, KATEGORI_BEHANDLET);
    return { ok: false, fejl: 'Ingen PDF-vedhæftninger' };
  }

  console.log(`[Agent] Fandt ${pdfs.length} PDF(er): ${pdfs.map(p => p.name).join(', ')}`);

  // Konverter vedhæftninger til base64 array
  const b64Array = pdfs.map(p => p.contentBytes);

  // Byg transport-objekt — Claude-data hvor den har noget, ellers kunde-default
  const skibsEllerBilnr = mailInfo.skibsnr || mailInfo.bilnr || '';
  const erBaad = (mailInfo.erBaad !== undefined && mailInfo.erBaad !== null)
    ? mailInfo.erBaad
    : kundeConfig.erBaad;
  const transportObj = {
    toldsted: mailInfo.opstartsToldsted || kundeConfig.toldsted,
    exitToldsted: mailInfo.udgangsToldsted || (mailInfo.koererViaSverige ? '' : kundeConfig.exitToldsted),
    customsCode: kundeConfig.customsCode || '',     // NO_EX: udgangstoldsted, fx 3770 for Svinesund
    kundenummer: kundeConfig.kundenummer || '',     // NO_EX: ordregiver i Waybill
    kundeNavn: kundeConfig.navn || '',              // NO_EX: klientnavn i Waybill
    erBaad: erBaad,
    borderId: skibsEllerBilnr,
    borderNat: mailInfo.bilNationalitet || kundeConfig.defaultBorderNat || 'NO',
    arrivalId: skibsEllerBilnr,
    arrivalNat: mailInfo.bilNationalitet || kundeConfig.defaultBorderNat || 'DK'
  };

  // Moduler — to scenarier:
  //   Kendt kunde: start med kundens whitelist-moduler, filtrér evt. via Claude's tolkning
  //   Ukendt kunde: brug UDELUKKENDE Claude's tolkning (whitelist-moduler er tomt)
  let aktiveModuler = kundeConfig.moduler || [];
  if (kundeConfig.erUkendtKunde) {
    // Ukendt kunde — Claude bestemmer modulerne
    if (mailInfo.moduler && mailInfo.moduler.length > 0) {
      aktiveModuler = mailInfo.moduler;
      console.log('[Agent] UKENDT KUNDE — moduler fra Claude: ' + aktiveModuler.join(',') + ' (konfidens: ' + mailInfo.konfidens + ')');
    } else {
      // Claude kunne ikke finde nogen moduler i mailen — default til DK_EX + NO_IM (mest almindelige kombination)
      aktiveModuler = ['DK_EX', 'NO_IM'];
      console.log('[Agent] UKENDT KUNDE — Claude kunne ikke identificere moduler, bruger default DK_EX+NO_IM (manual gennemgang påkrævet)');
    }
  } else if (mailInfo.moduler && mailInfo.moduler.length > 0 && mailInfo.konfidens !== 'lav') {
    // Kendt kunde + Claude har fundet noget med konfidens — filtrér til delmængde af whitelist
    const tilladt = new Set(kundeConfig.moduler);
    const filtreret = mailInfo.moduler.filter(m => tilladt.has(m));
    if (filtreret.length > 0) {
      aktiveModuler = filtreret;
      console.log('[Agent] Moduler fra mail-analyse: ' + filtreret.join(',') + ' (kundens fulde sæt: ' + kundeConfig.moduler.join(',') + ')');
    }
  }

  // Safety net — hvis vi står med tomme moduler efter al logik, fejl tidligt
  if (!aktiveModuler || aktiveModuler.length === 0) {
    throw new Error('Ingen moduler kunne identificeres for denne mail. Tjek mailteksten eller behandl manuelt.');
  }

  // Kald vores egen extract-all API
  const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
  const extractResp = await fetch(baseUrl + '/api/extract-all', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ b64Array, totalPages: 1 })
  });

  if (!extractResp.ok) {
    const err = await extractResp.text();
    throw new Error('extract-all fejl: ' + err);
  }

  const data = await extractResp.json();
  console.log('[Agent] Udtræk OK — ref (fra PDF):', data.header?.Afregningsreference?.value, '— varelinjer:', data.varelinjer?.length);

  // Sagsreference fra mailen trumfer PDF'ens egen reference (fx Toplogistik's "REF: FT2624387")
  // Hvis Claude fandt en sagsreference i mailen, brug den som Afregningsreference i XML'en
  if (mailInfo.sagsreference && mailInfo.sagsreference.trim()) {
    const mailRef = mailInfo.sagsreference.trim();
    if (!data.header) data.header = {};
    data.header['Afregningsreference'] = { value: mailRef, confidence: 'high' };
    console.log('[Agent] Afregningsreference overridet fra mail: ' + mailRef);
  }

  // Hvis Claude fandt bilnummer/nationalitet i mailen og ingen var i transportObj endnu
  if (mailInfo.bilnr && !transportObj.borderId) {
    transportObj.borderId = mailInfo.bilnr;
    transportObj.arrivalId = mailInfo.bilnr;
  }

  // NO_EX CustomsCode fra mail hvis Claude fandt den — trumfer kunde-default
  if (mailInfo.noExCustomsCode && mailInfo.noExCustomsCode.trim()) {
    transportObj.customsCode = mailInfo.noExCustomsCode.trim();
    console.log('[Agent] NO_EX CustomsCode fra mail: ' + transportObj.customsCode);
  }

  const ref = data.header?.Afregningsreference?.value || 'ukendt';
  const afsender = data.header?.['Afsender navn']?.value || kundeConfig.navn;

  // ─── Post-validering: korriger moduler baseret på fakturaens lande ────────
  // Mailteksten kan være tvetydig ("export + import, grænse Larvik+Hirtshals" — kan være begge veje).
  // PDF'en viser tydeligt retningen via afsender/modtager land. Hvis ukendt kunde og NO↔DK,
  // tving moduler til at matche fakturaens retning. Kendte kunder stoler vi på whitelisten for.
  if (kundeConfig.erUkendtKunde) {
    const norm = (s) => {
      const x = (s || '').trim().toUpperCase();
      if (!x) return '';
      if (x.startsWith('NORG') || x === 'NORWAY' || x === 'NO') return 'NO';
      if (x.startsWith('DANM') || x === 'DENMARK' || x === 'DK') return 'DK';
      return x.substring(0, 2);
    };
    const afsLand = norm(data.header?.['Afsender land']?.value);
    const modLand = norm(data.header?.['Modtager land']?.value);

    let korrigeretModuler = null;
    if (afsLand === 'NO' && modLand === 'DK') {
      korrigeretModuler = ['NO_EX', 'DK_IM'];
    } else if (afsLand === 'DK' && modLand === 'NO') {
      korrigeretModuler = ['DK_EX', 'NO_IM'];
    }

    if (korrigeretModuler && korrigeretModuler.join(',') !== aktiveModuler.join(',')) {
      console.log(`[Agent] MODUL-KORREKTION (ukendt kunde, fakturaens lande ${afsLand}→${modLand}): ${aktiveModuler.join(',')} → ${korrigeretModuler.join(',')}`);
      aktiveModuler = korrigeretModuler;
    }
  }

  // Generer XML for hvert aktivt modul — altid dryRun=1 her; uploader i separat trin ved godkendelse
  const xmlFiler = [];
  for (const modul of aktiveModuler) {
    const [mod, typeKode] = modul.split('_');
    const type = typeKode === 'EX' ? 'export' : 'import';

    const params = new URLSearchParams({
      data: JSON.stringify(data),
      module: mod,
      type: type,
      transport: JSON.stringify(transportObj),
      dryRun: '1' // Altid dryRun — vi uploader først ved godkendelse
    });

    const xmlResp = await fetch(baseUrl + '/api/export-xml', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params
    });

    if (!xmlResp.ok) {
      console.error(`[Agent] XML generering fejlede for ${modul}`);
      continue;
    }

    const filename = xmlResp.headers.get('content-disposition')?.match(/filename="(.+)"/)?.[1] || `${mod}_${typeKode}_emma.xml`;
    const xmlBytes = await xmlResp.arrayBuffer();
    const xmlBase64 = Buffer.from(xmlBytes).toString('base64');
    xmlFiler.push({ filename, xmlBase64, module: mod });
    console.log(`[Agent] XML genereret: ${filename}`);
  }

  if (xmlFiler.length === 0) {
    throw new Error('Ingen XML-filer kunne genereres');
  }

  // Gem pending godkendelse
  const tokenId = nytTokenId();
  pendingApprovals.set(tokenId, {
    xmls: xmlFiler,
    extractedData: data,
    moduler: aktiveModuler,            // Claude's tolkning eller kunde-default
    alleModulerTilladt: kundeConfig.moduler, // hele settet kunden kan bruge — UI kan vise de andre som inaktive checkboxes
    transportObj,
    ref,
    kundeNavn: kundeConfig.navn,
    erUkendtKunde: !!kundeConfig.erUkendtKunde,  // flag så UI kan vise advarsel
    afsenderMail: fra,
    emne: subject,
    mailTekst: bodyTekst.substring(0, 5000), // brødtekst til visning i Gennemse-siden
    mailInfo,                          // Claude's fulde tolkning (bilnr, konfidens, instruktioner osv.)
    pdfNames: pdfs.map(p => p.name),
    varelinjerAntal: data.varelinjer?.length || 0,
    createdAt: Date.now()
  });

  const gennemseLink = `${PUBLIC_URL}/?pending=${tokenId}`;
  const godkendLink = `${PUBLIC_URL}/api/godkend/${tokenId}`;
  const afvisLink = `${PUBLIC_URL}/api/afvis/${tokenId}`;

  // Find hvem der claim'ede mailen (via kategori-farve)
  const ansvarlig = findAnsvarlig(mail.categories);
  const ansvarligLinje = ansvarlig
    ? `<p style="margin:0;color:#78350f"><b>Din opgave, ${ansvarlig.navn}</b> — du tog denne mail (kategori: ${ansvarlig.kategori}). Toldagenten har behandlet PDF'en og genereret XML-filer.</p>`
    : `<p style="margin:0;color:#78350f">Toldagenten har behandlet en mail og genereret XML-filer.</p>`;

  const xmlListe = xmlFiler.map(x => `<li><code>${x.filename}</code></li>`).join('');

  // Byg bokse med Claude's tolkning
  const konfidensFarve = {
    'hoej': '#16a34a',
    'mid': '#ca8a04',
    'lav': '#dc2626'
  }[mailInfo.konfidens] || '#666';
  const modulerTekst = (aktiveModuler || []).join(' + ');
  const transportTekst = mailInfo.erBaad
    ? `🚢 Sejler direkte${mailInfo.skibsnr ? ' (skib '+mailInfo.skibsnr+')' : ''}`
    : (mailInfo.koererViaSverige ? '🚚 Kører via Sverige' : '🚚 Landtransport');
  const instrLinje = mailInfo.specielleInstruktioner
    ? `<tr><td style="padding:6px 0;color:#666">Særlige instruktioner</td><td style="color:#9a3412"><b>⚠ ${mailInfo.specielleInstruktioner}</b></td></tr>`
    : '';
  const refLinje = mailInfo.sagsreference
    ? `<tr><td style="padding:6px 12px;color:#666">Sagsreference fra mail</td><td><b>${mailInfo.sagsreference}</b></td></tr>`
    : '';
  const noExLinje = mailInfo.noExCustomsCode
    ? `<tr><td style="padding:6px 12px;color:#666">NO_EX Udgangstoldsted</td><td>${mailInfo.noExCustomsCode}</td></tr>`
    : '';

  // Ukendt kunde → stort rødt advarselsbanner + fjern "Godkend direkte" for at tvinge gennemgang
  const ukendtKundeBanner = kundeConfig.erUkendtKunde ? `
      <div style="background:#fef2f2;border:2px solid #dc2626;padding:14px 18px;margin-bottom:16px;border-radius:8px">
        <h3 style="margin:0 0 6px 0;color:#991b1b;font-size:15px">🚨 UKENDT KUNDE — Claude har gættet profilen</h3>
        <p style="margin:0;color:#7f1d1d;font-size:13px;line-height:1.5">Afsender <b>${fra}</b> er ikke på whitelisten — robotten har brugt Claudes tolkning af mailen til at bestemme moduler, toldsteder og transport. <b>Tjek alle felter ekstra grundigt.</b></p>
        <p style="margin:8px 0 0 0;color:#7f1d1d;font-size:12px">Hvis denne kunde sender ofte, kan vi tilføje dem til whitelisten bagefter.</p>
      </div>` : '';

  // 'GODKEND DIREKTE'-knappen er fjernet bevidst — alle mails skal gennem Gennemse-flow'et først
  // så medarbejderen kan tjekke data og derefter bruge 'Godkend og gem til Emma'-knappen i UI.

  const emailBody = `
    <div style="font-family:sans-serif;max-width:600px">
      ${ukendtKundeBanner}
      <div style="background:#fef3c7;border:2px solid #f59e0b;padding:16px;margin-bottom:20px;border-radius:8px">
        <h2 style="margin:0 0 8px 0;color:#92400e">⏳ Afventer din godkendelse</h2>
        ${ansvarligLinje}
        <p style="margin:8px 0 0 0;color:#78350f">Klik Gennemse for at se data, rette evt. fejl, og godkende. XML-filerne gemmes direkte i Emma-mapperne når du godkender.</p>
      </div>

      <table style="border-collapse:collapse;width:100%;font-size:14px">
        <tr><td style="padding:6px 0;color:#666;width:160px">Kunde</td><td><b>${afsender}</b></td></tr>
        <tr><td style="padding:6px 0;color:#666">Reference</td><td><b>${ref}</b></td></tr>
        <tr><td style="padding:6px 0;color:#666">PDF'er behandlet</td><td>${pdfs.map(p => p.name).join(', ')}</td></tr>
        <tr><td style="padding:6px 0;color:#666">Varelinjer fundet</td><td>${data.varelinjer?.length || 0}</td></tr>
      </table>

      <h3 style="margin-top:20px;margin-bottom:8px;font-size:14px">Robottens tolkning af mailen <span style="background:${konfidensFarve};color:white;font-size:11px;padding:2px 8px;border-radius:10px;font-weight:normal">Konfidens: ${mailInfo.konfidens || 'ukendt'}</span></h3>
      <table style="border-collapse:collapse;width:100%;font-size:14px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;padding:4px">
        <tr><td style="padding:6px 12px;color:#666;width:160px">Moduler</td><td><b>${modulerTekst || '—'}</b></td></tr>
        ${refLinje}
        <tr><td style="padding:6px 12px;color:#666">Transport</td><td>${transportTekst}</td></tr>
        <tr><td style="padding:6px 12px;color:#666">Bilnr / skibsnr</td><td>${mailInfo.bilnr || mailInfo.skibsnr || '—'}${mailInfo.bilNationalitet ? ' ('+mailInfo.bilNationalitet+')' : ''}</td></tr>
        <tr><td style="padding:6px 12px;color:#666">Opstartstoldsted</td><td>${mailInfo.opstartsToldsted || (transportObj.toldsted + ' <i style="color:#999">(default)</i>')}</td></tr>
        <tr><td style="padding:6px 12px;color:#666">Udgangstoldsted</td><td>${mailInfo.udgangsToldsted || '<i style="color:#999">samme som opstart</i>'}</td></tr>
        ${noExLinje}
        <tr><td style="padding:6px 12px;color:#666">Dato</td><td>${mailInfo.dato || '—'}</td></tr>
        ${instrLinje}
      </table>

      <h3 style="margin-top:20px;margin-bottom:8px;font-size:14px">Genererede XML-filer (vedhæftet):</h3>
      <ul>${xmlListe}</ul>

      <div style="margin:30px 0;text-align:center">
        <a href="${gennemseLink}" style="display:inline-block;background:#16a34a;color:white;padding:14px 28px;text-decoration:none;border-radius:8px;font-weight:bold;font-size:15px;margin-right:8px">🔍 GENNEMSE OG GODKEND</a>
        <a href="${afvisLink}" style="display:inline-block;background:#dc2626;color:white;padding:14px 28px;text-decoration:none;border-radius:8px;font-weight:bold;font-size:15px">❌ AFVIS</a>
      </div>

      <p style="color:#888;font-size:12px;border-top:1px solid #eee;padding-top:12px">
        Tip: <b>hvis konfidens er "lav"</b> eller særlige instruktioner er nævnt, så brug Gennemse og tjek data før godkendelse.<br>
        Links udløber efter 24 timer. Hvis du ikke reagerer, bliver intet sendt til Emma.
      </p>
    </div>
  `;

  // Send approval til den person der claim'ede mailen — fallback til default hvis ingen match
  const notifEmail = ansvarlig ? ansvarlig.email : (process.env.AGENT_NOTIFY_EMAIL || 'cw@cwcs.dk');
  const subjectPrefix = ansvarlig ? `[${ansvarlig.navn}] ` : '';
  await sendMail(
    notifEmail,
    `🔔 ${subjectPrefix}Godkend: ${kundeConfig.navn} — ${ref}`,
    emailBody,
    xmlFiler
  );
  console.log(`[Agent] Godkendelsesmail sendt til ${notifEmail}${ansvarlig ? ' (' + ansvarlig.navn + ')' : ''} — tokenId: ${tokenId.substring(0, 8)}...`);

  // Markér mail med CW-Robot — bevarer medarbejder-farven (Outlook understøtter flere kategorier samtidig)
  await markerMail(mailId, mail.categories, KATEGORI_BEHANDLET);

  return { ok: true, ref, pending: true, tokenId };
}

// ─── Kategorier — matcher jeres farvesystem i Outlook ────────────────────────
// Robotten behandler mails der har en medarbejder-farve (en person har "taget" opgaven).
// Approval-mailen sendes til den person hvis farve er på mailen.
const KATEGORI_TRIGGER   = 'CW-Robot';         // Medarbejderen sætter denne for at starte robotten
const KATEGORI_BEHANDLET = 'CW-Robot FÆRDIG';  // Robotten tilføjer denne når behandling er succesfuld
const KATEGORI_FEJL      = 'CW-Robot FEJL';    // Robotten tilføjer denne hvis behandling fejler

// Medarbejdere og deres mulige kategori-navne i Outlook.
// Accepterer flere varianter så vi matcher uanset om kategori hedder "grøn",
// "Grøn kategori" (dansk standard), "Green Category" (engelsk), personnavn eller initialer.
const MEDARBEJDERE = [
  { navn: 'Claes',    email: 'cw@cwcs.dk',  farver: ['grøn','groen','grøn kategori','green','green category','claes','cw'] },
  { navn: 'Simon',    email: 'slj@cwcs.dk', farver: ['gul','gul kategori','yellow','yellow category','simon','slj'] },
  { navn: 'Mark',     email: 'mhz@cwcs.dk', farver: ['blå','blaa','blå kategori','blue','blue category','mark','mhz'] },
  { navn: 'Michelle', email: 'mhc@cwcs.dk', farver: ['lavendel','lavendel kategori','lavender','lavender category','lilla','purple','purple category','michelle','mhc'] },
  { navn: 'Uni',      email: 'ujo@cwcs.dk', farver: ['rød','roed','rød kategori','red','red category','uni','ujo'] }
];

// Byg case-insensitive lookup-map ved opstart
const FARVE_LOOKUP = {};
for (const m of MEDARBEJDERE) {
  for (const farve of m.farver) {
    FARVE_LOOKUP[farve.toLowerCase()] = m;
  }
}

function findAnsvarlig(categories) {
  for (const cat of categories || []) {
    const mnd = FARVE_LOOKUP[(cat || '').toLowerCase()];
    if (mnd) return { ...mnd, kategori: cat };
  }
  return null;
}

// Tilføjer en kategori uden at fjerne eksisterende (så medarbejder-farven bevares)
async function markerMail(mailId, eksisterendeKategorier, nyKategori) {
  const cats = (eksisterendeKategorier || []).filter(c => c !== nyKategori);
  cats.push(nyKategori);
  try {
    await graphPatch(`/users/${MAILBOX}/messages/${mailId}`, {
      isRead: true,
      categories: cats
    });
  } catch(e) {
    console.error('[Agent] Kunne ikke sætte kategori "' + nyKategori + '":', e.message);
  }
}

// ─── Hoved polling loop ───────────────────────────────────────────────────────
export async function startMailAgent() {
  if (!process.env.MS_TENANT_ID || !process.env.MS_CLIENT_ID || !process.env.MS_CLIENT_SECRET) {
    console.log('[Agent] MS_TENANT_ID/MS_CLIENT_ID/MS_CLIENT_SECRET ikke sat — agent ikke startet');
    return;
  }

  console.log(`[Agent] Starter — tjekker ${MAILBOX} hvert ${CHECK_INTERVAL_MS/60000} min`);
  console.log(`[Agent] ${MEDARBEJDERE.length} medarbejdere i lookup: ${MEDARBEJDERE.map(m => m.navn + ' (' + m.email + ')').join(', ')}`);
  console.log(`[Agent] Toldmail-agent startet. Tjekker inbox hvert ${CHECK_INTERVAL_MS/1000}s.`);
  console.log(`[Agent] Mails behandles KUN hvis BÅDE en medarbejder-farve (Claes/Simon/Mark/Michelle/Uni) OG trigger-kategorien "${KATEGORI_TRIGGER}" er sat.`);
  console.log(`[Agent] Efter behandling tilføjer robotten: "${KATEGORI_BEHANDLET}" (succes) eller "${KATEGORI_FEJL}" (fejl).`);

  async function tjekMails() {
    try {
      // Hent mails fra sidste 24 timer (vi filtrerer på kategori i klient)
      const etDoegnSiden = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const result = await graphGet(
        `/users/${MAILBOX}/mailFolders/inbox/messages?$filter=receivedDateTime ge ${etDoegnSiden}&$select=id,subject,from,categories,receivedDateTime&$top=50`
      );

      // Kun mails der opfylder ALLE tre betingelser:
      //   1. Har en medarbejder-farve (en person har "taget" opgaven)
      //   2. Har trigger-kategorien "CW-Robot" (eksplicit signal om at robotten skal behandle)
      //   3. Har IKKE allerede "CW-Robot Færdig" eller "CW-Robot FEJL" (er allerede behandlet)
      const alleMails = result.value || [];

      // Diagnostic log — vis alle mails og deres kategorier, så vi kan se om filteret fejler
      const claimedButNotTriggered = [];
      const mails = alleMails.filter(m => {
        const cats = m.categories || [];
        const catsLower = cats.map(c => (c || '').toLowerCase());
        // Allerede behandlet? — spring over (case-insensitivt)
        if (catsLower.includes(KATEGORI_BEHANDLET.toLowerCase()) || catsLower.includes(KATEGORI_FEJL.toLowerCase())) return false;
        // Begge krav skal være opfyldt — case-insensitivt
        const harFarve = cats.some(c => FARVE_LOOKUP[(c || '').toLowerCase()]);
        const harTrigger = catsLower.includes(KATEGORI_TRIGGER.toLowerCase());
        if (harFarve && !harTrigger) {
          // Nyttig diagnostic: medarbejder har claim'et men ikke trigget — vis i log
          claimedButNotTriggered.push({
            fra: m.from?.emailAddress?.address || '?',
            emne: (m.subject || '').substring(0, 60),
            kategorier: cats
          });
        }
        return harFarve && harTrigger;
      });

      if (claimedButNotTriggered.length > 0) {
        console.log(`[Agent] ${claimedButNotTriggered.length} claim'et mail(s) uden "${KATEGORI_TRIGGER}"-trigger (robot rører dem ikke):`);
        claimedButNotTriggered.forEach(m => console.log(`  - ${m.fra} | "${m.emne}" | kategorier: [${m.kategorier.join(', ')}]`));
      }

      if (mails.length > 0) {
        console.log(`[Agent] ${mails.length} mail(s) med farve+${KATEGORI_TRIGGER} klar til behandling (af ${alleMails.length} i sidste 24 timer)`);
      }

      for (const mail of mails) {
        const fra = mail.from?.emailAddress?.address?.toLowerCase() || '';
        const domæne = fra.split('@')[1] || '';

        let kundeConfig = WHITELIST[fra] || WHITELIST[domæne];
        let erUkendtKunde = false;
        if (!kundeConfig) {
          // UKENDT KUNDE — brug default-profil og lad Claude gætte modulerne fra mail+PDF
          erUkendtKunde = true;
          console.log(`[Agent] ${fra} ikke på whitelist — behandler med Claude-gætning (ukendt kunde)`);
          kundeConfig = {
            navn: fra,                              // Vis afsender-email som kundenavn indtil vi ved bedre
            moduler: [],                            // Tom — Claude udfylder via mail-analyse
            toldsted: '',                           // Tom — Claude læser fra mail, ellers vælger medarbejder
            exitToldsted: '',
            erBaad: null,                           // null betyder "Claude bestemmer", ikke false
            manualApproval: true,                   // ALTID manual godkendelse for ukendte
            erUkendtKunde: true                     // Flag så godkendelsesmailen kan vise advarsel
          };
        }

        try {
          await behandlMail(mail, kundeConfig);
          // behandlMail markerer selv med KATEGORI_BEHANDLET
        } catch(err) {
          console.error(`[Agent] Fejl ved behandling af mail fra ${fra}:`, err.message);
          // Markér med fejl-kategori så vi ikke retry'er i det uendelige
          await markerMail(mail.id, mail.categories, KATEGORI_FEJL);
          const ansvarlig = findAnsvarlig(mail.categories);
          const notifEmail = ansvarlig ? ansvarlig.email : (process.env.AGENT_NOTIFY_EMAIL || 'cw@cwcs.dk');
          await sendMail(notifEmail,
            `⚠️ Toldagent FEJL — ${fra}`,
            `<h2>Toldagent fejl</h2><p>Mail fra: ${fra}</p><p>Emne: ${mail.subject}</p><p>Fejl: ${err.message}</p><p>Mailen er markeret med kategorien <b>${KATEGORI_FEJL}</b>. For at forsøge igen: fjern <b>${KATEGORI_FEJL}</b>-kategorien i Outlook, tjek at <b>${KATEGORI_TRIGGER}</b> stadig er sat, og robotten vil automatisk tage mailen igen ved næste tjek. Alternativt kan mailen håndteres manuelt.</p>`
          ).catch(() => {});
        }
      }
    } catch(err) {
      console.error('[Agent] Polling fejl:', err.message);
    }
  }

  await tjekMails();
  setInterval(tjekMails, CHECK_INTERVAL_MS);
}

// ─── Test endpoint ────────────────────────────────────────────────────────────
export async function testMailAgent() {
  try {
    const token = await getGraphToken();
    return { ok: true, besked: 'Graph API forbindelse OK', mailbox: MAILBOX };
  } catch(err) {
    return { ok: false, fejl: err.message };
  }
}
