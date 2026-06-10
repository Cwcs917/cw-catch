import express from 'express';
import fetch from 'node-fetch';
import path from 'path';
import { fileURLToPath } from 'url';
import { PDFDocument } from 'pdf-lib';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(__dirname));

const ACTIVE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-5-20250929';

// ─── Claude kald ──────────────────────────────────────────────────────────────
async function callClaude(apiKey, b64, prompt, maxTokens) {
  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01'
  };
  console.log('callClaude model:', ACTIVE_MODEL);

  const MAX_RETRIES = 3;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: ACTIVE_MODEL,
        max_tokens: maxTokens,
        temperature: 0,
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
        const wait = attempt * 8000;
        console.log('API overbelastet, venter ' + (wait/1000) + 's (forsøg ' + attempt + '/' + MAX_RETRIES + ')');
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      console.error('Claude API fejl:', JSON.stringify(data.error));
      throw new Error(data.error.message || JSON.stringify(data.error));
    }
    return data.content[0].text;
  }
}

// ─── CATCH prompt ─────────────────────────────────────────────────────────────
const CATCH_PROMPT = `Du er ekspert i EU IUU-regulering og CATCH-systemet (TRACES). 
Udtræk data fra disse fangstdokumenter og map dem præcist til CATCH-rubriknumrene.
Dokumenterne kan indeholde: CATCH certifikat, Processing statement, Health Certificate, Invoice, Packing List, Bill of Lading.

Svar KUN med JSON uden markdown eller forklaring.

REGLER:
- Brug kun information der faktisk fremgår af dokumenterne
- Hvis et felt ikke findes, sæt værdien til null
- Boks 2 processing: hvis feltet er tomt i dokumentet, sæt "n/a"
- Boks 3 rfmo og Boks 4: hvis ikke relevant, sæt "n/a"
- Datoer skrives som de står i dokumentet
- Vægt angives i kg som tal uden enhed

Returner dette JSON-objekt:
{
  "boks1_myndighed_navn": "navn på validating authority",
  "boks1_land": "land ISO-kode eller fuldt navn",

  "boks2_fartoej_navn": "fartøjets navn",
  "boks2_hjemhavn": "hjemhavn",
  "boks2_registreringsnr": "nationalt registreringsnummer",
  "boks2_kaldesignal": "kaldesignal",
  "boks2_imo": "IMO eller UVI nummer",
  "boks2_fiskerilicens": "fiskerilicensnummer",
  "boks2_processing": "type of processing ombord eller n/a",

  "boks3_kn_kode": "KN/HS-kode",
  "boks3_species": "fiskeart latinsk navn eller handelsnavn",
  "boks3_fao_zone": "FAO fangstområde fx 57 Indian Ocean Eastern",
  "boks3_eez": "EEZ eller High seas angivelse",
  "boks3_rfmo": "RFMO navn eller n/a",
  "boks3_fangst_fra": "fangstdato start",
  "boks3_fangst_til": "fangstdato slut",
  "boks3_vaegt_kg": "vægt i kg",

  "boks4_rfmo": "RFMO reference eller n/a",

  "boks5_kaptajn_navn": "kaptajnens navn",
  "boks5_signatur": "Ja hvis signatur er til stede, Nej hvis ikke, Ulæselig hvis ulæselig",

  "boks8_eksportoer_navn": "eksportørens navn",
  "boks8_land": "eksportørens land",
  "boks8_signatur_dato": "dato for eksportørens signatur",
  "boks8_stempel": "Ja hvis signatur og stempel er til stede, Nej hvis ikke",

  "boks9_navn": "navn på Flag State authority person",
  "boks9_signatur_dato": "dato for Flag State signatur",
  "boks9_stempel": "Ja hvis signatur og stempel er til stede, Nej hvis ikke",

  "transport_eksportland": "eksportland",
  "transport_afsendelse": "afsendelseshavn eller lufthavn",
  "transport_middel": "Skib eller Fly eller Lastbil",
  "transport_skib": "skibsnavn eller flynummer eller vognnummer",
  "transport_container": "containernummer",
  "transport_plombe": "plombenummer",

  "doc_fangstattest_nr": "fangstattestens dokumentnummer",
  "doc_udstedelsesdato": "udstedelsesdato",
  "doc_flagstat": "flagstat land"
}`;

// ─── /api/catch-extract ───────────────────────────────────────────────────────
app.post('/api/catch-extract', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API nøgle ikke konfigureret.' });

  try {
    const b64Array = req.body.b64Array;
    if (!b64Array || !Array.isArray(b64Array) || b64Array.length === 0) {
      return res.status(400).json({ error: 'Ingen PDF data modtaget.' });
    }

    // Merge alle PDF-filer til én
    let b64;
    if (b64Array.length > 1) {
      console.log('Merger ' + b64Array.length + ' PDF-filer...');
      const mergedPdf = await PDFDocument.create();
      for (let i = 0; i < b64Array.length; i++) {
        try {
          const bytes = Buffer.from(b64Array[i], 'base64');
          const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
          const pages = await mergedPdf.copyPages(src, src.getPageIndices());
          pages.forEach(p => mergedPdf.addPage(p));
          console.log('PDF ' + (i+1) + ': ' + src.getPageCount() + ' sider tilføjet');
        } catch(e) {
          console.log('PDF ' + (i+1) + ' merge fejl (springer over):', e.message);
        }
      }
      const mergedBytes = await mergedPdf.save();
      b64 = Buffer.from(mergedBytes).toString('base64');
      console.log('Merge færdig: ' + mergedPdf.getPageCount() + ' sider i alt');
    } else {
      b64 = b64Array[0];
    }

    const pdfSizeBytes = Math.round(b64.length * 0.75);
    const pdfSizeMB = (pdfSizeBytes / 1024 / 1024).toFixed(2);
    console.log('CATCH PDF størrelse: ' + pdfSizeMB + ' MB');
    if (pdfSizeBytes > 30 * 1024 * 1024) {
      return res.status(400).json({ error: 'PDF er for stor (' + pdfSizeMB + ' MB). Max 30 MB.' });
    }

    console.log('Kalder Claude for CATCH-udtræk...');
    const rawText = await callClaude(apiKey, b64, CATCH_PROMPT, 2000);
    console.log('Claude svar:', rawText.substring(0, 200));

    // Parse JSON
    let result;
    try {
      const clean = rawText.replace(/```json|```/g, '').trim();
      result = JSON.parse(clean);
    } catch(e) {
      console.error('JSON parse fejl:', e.message);
      return res.status(500).json({ error: 'Kunne ikke parse Claude svar: ' + e.message });
    }

    res.json(result);

  } catch(err) {
    console.error('catch-extract fejl:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => res.json({ status: 'ok', service: 'cw-catch' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('CW-CATCH server kører på port ' + PORT));
