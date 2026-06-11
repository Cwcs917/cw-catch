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

const CATCH_PROMPT = `Du er ekspert i EU IUU-regulering og CATCH-systemet (TRACES).
Udtræk data fra disse fangstdokumenter og map dem præcist til CATCH-rubriknumrene.
Dokumenterne kan indeholde: CATCH certifikat (CC), Annex B, Processing Statement, Health Certificate, Invoice, Packing List, Bill of Lading.

Svar KUN med JSON uden markdown eller forklaring.

REGLER:
- Brug kun information der faktisk fremgaar af dokumenterne
- Hvis et felt ikke findes, saet vaerdien til null
- Boks 2 processing: hvis feltet er tomt eller "NO" i dokumentet, saet "NO"
- Boks 3 rfmo og Boks 4: hvis ikke relevant, saet "n/a"
- Datoer skrives som de staar i dokumentet
- Vaegt angives i kg som tal uden enhed

VIGTIGT OM BOKS 2 FARTOJER:
Hent alle fartoejer fra CATCH-certifikatets boks 2 eller Annex B. Inkluder ALLE fartoejer - ingen maa springes over.

VIGTIGT OM KN-KODER I BOKS 3:
Der er to KN-koder i et CATCH-dokument:
1. boks3_kn_raaprodukt er KN-koden for den fangede fisk i raa form. Findes i CATCH certifikatet under "Product code" eller "Partida arancelaria". Eksempel: 030343 eller 03034300.
2. boks3_kn_forarbejdet er den FULDE KN-kode for det forarbejdede produkt. Findes i Processing Statement (feltet "EN ACEITE xxxxxxxx") eller i CHEDP/Health Certificate. Returner koden UDEN mellemrum med alle cifre, fx 1604142013 eller 16041421. Dette er en 8-10 cifret kode - afkort den ikke.
Hvis der kun er en KN-kode, saet den i boks3_kn_raaprodukt og saet boks3_kn_forarbejdet til null.

VIGTIGT OM VAEGT I BOKS 3 PRODUKTLINJER:
Vaegter hentes fra CATCH-certifikatet (CC) eller Annex B - aldrig fra Processing Statement.

Digitalt TRACES CC (engelsk format) - vaegter per produktlinje hedder:
- "Estimated weight to be landed in kg" -> est_vaegt_kg
- "Net catch weight in kg" -> net_catch_kg
- "Verified weight landed (net catch weight in kg)" -> verified_kg

Annex B (spansk/ecuadoriansk format) - kolonner hedder:
- "Captura total del buque (Kg)" -> net_catch_kg (den samlede fangst for fartoejet)
- "Captura transformada a base de la captura total (Kg)" -> verified_kg (den forarbejdede del)
- est_vaegt_kg -> saet null hvis ikke til stede i Annex B

Hvis CC boks 3 siger "Ver anexo B" skal du laese vaegterne fra Annex B i stedet.
Saet null hvis et felt ikke fremgaar af nogen af disse kilder.
ADVARSEL: Brug ALDRIG tal fra Processing Statement (catch processed / processed fishery product) til disse felter.

VIGTIGT OM OMLADNING:
Boks 6 udfyldes hvis omladning paa havet. Boks 7 udfyldes hvis omladning i havn. Ingen omladning giver null paa alle boks6 og boks7 felter.

Returner dette JSON-objekt:
{
  "boks1_myndighed_navn": "navn paa validating authority",
  "boks1_land": "land",
  "boks2_fartojer": [
    {
      "navn": "fartoejets navn",
      "hjemhavn": "hjemhavn",
      "registreringsnr": "nationalt registreringsnummer",
      "kaldesignal": "kaldesignal",
      "imo": "IMO eller UVI nummer",
      "fiskerilicens": "fiskerilicensnummer",
      "processing": "type of processing eller n/a"
    }
  ],
  "boks3_kn_raaprodukt": "KN-kode for raa fanget fisk fx 030343",
  "boks3_kn_forarbejdet": "KN-kode for forarbejdet produkt fx 1604 20 70 eller null",
  "boks3_species": "fiskeart latinsk navn og FAO-kode fx SKJ Katsuwonus pelamis",
  "boks3_produktlinjer": [
    {
      "fartoej": "fartoejets navn og registreringsnummer",
      "fao_zone": "FAO omraade fx FAO 87 Pacific Southeast",
      "eez": "EEZ land eller High seas",
      "rfmo": "RFMO navn eller n/a",
      "fangst_fra": "fangstdato start",
      "fangst_til": "fangstdato slut",
      "est_vaegt_kg": "estimated weight to be landed i kg",
      "net_catch_kg": "net catch weight i kg",
      "verified_kg": "verified weight landed i kg"
    }
  ],
  "boks4_rfmo": "RFMO reference eller n/a",
  "boks5_kaptajn_navn": "kaptajnens navn",
  "boks5_signatur": "Ja eller Nej eller Ulaeselig",
  "boks6_omladning_hav": "Ja eller Nej",
  "boks6_omladningsfartoj": "omladningsfartoejets navn eller null",
  "boks6_omladningsdato": "dato for omladning paa havet eller null",
  "boks7_omladning_havn": "Ja eller Nej",
  "boks7_havn": "havnens navn eller null",
  "boks7_omladningsdato": "dato for omladning i havn eller null",
  "boks8_eksportoer_navn": "eksportoerens navn",
  "boks8_land": "eksportoerens land",
  "boks8_signatur_dato": "dato for eksportoerens signatur",
  "boks8_stempel": "Ja eller Nej",
  "boks9_navn": "navn paa Flag State authority person",
  "boks9_signatur_dato": "dato for Flag State signatur",
  "boks9_stempel": "Ja eller Nej",
  "transport_eksportland": "eksportland",
  "transport_afsendelse": "afsendelseshavn eller lufthavn",
  "transport_middel": "Skib eller Fly eller Lastbil",
  "transport_skib": "skibsnavn eller flynummer",
  "transport_container": "containernummer",
  "transport_plombe": "plombenummer, hvis flere adskil med komma",
  "doc_fangstattest_nr": "fangstattestens dokumentnummer",
  "doc_udstedelsesdato": "udstedelsesdato",
  "doc_fangstattest_nr": "fangstattestens dokumentnummer",
  "doc_udstedelsesdato": "udstedelsesdato",
  "doc_flagstat": "flagstat land",

  "ps_findes": "true hvis der er en Processing Statement i dokumenterne, ellers false",
  "ps_dokumentnummer": "PS dokumentnummer fx 16910141202600004197P eller null",
  "ps_fabrik_navn": "navn paa forarbejdningsfabrik",
  "ps_fabrik_adresse": "adresse paa forarbejdningsfabrik",
  "ps_fabrik_godkendelsesnr": "godkendelsesnummer paa fabrik fx 51",
  "ps_ansvarlig_person": "navn paa ansvarlig person paa fabrik",
  "ps_dato": "dato for PS underskrift",
  "ps_sted": "sted for PS underskrift",
  "ps_kn_forarbejdet": "fuld KN-kode for det forarbejdede produkt fx 1604142013",
  "ps_linjer": [
    {
      "cc_nummer": "fangstattest nummer denne linje refererer til",
      "fartoej_navn": "fartoejets navn",
      "fartoej_flag": "fartoejet flag",
      "validering_dato": "valideringsdato",
      "fangst_beskrivelse": "fangstbeskrivelse fx KATSUWONUS PELAMIS",
      "total_landed_weight_kg": "total landed weight i kg som tal",
      "catch_processed_kg": "catch processed i kg som tal",
      "processed_fishery_product_kg": "processed fishery product i kg som tal"
    }
  ],
  "ps_sundhedscert_nr": "sundhedscertifikat nummer",
  "ps_sundhedscert_dato": "sundhedscertifikat dato",

  "im_importoer_navn": "importoerens firmanavn",
  "im_importoer_adresse": "importoerens adresse",
  "im_importoer_land": "importoerens land",
  "im_importoer_eori": "EORI nummer hvis tilgaengeligt eller null",
  "im_repraesentant_navn": "repraesentantens firmanavn speditoerets navn",
  "im_repraesentant_adresse": "repraesentantens adresse",
  "im_repraesentant_land": "repraesentantens land",
  "im_kn_kode": "KN-kode for det importerede produkt",
  "im_nettovægt_kg": "nettovægt i kg som tal",
  "im_net_fishery_product_weight_kg": "net fishery product weight i kg som tal",
  "im_forventet_ankomst": "forventet ankomstdato fra CHEDP eller null",
  "im_ched_nummer": "CHED nummer fx CHEDP.DK.2026.0003917 eller null",
  "im_customs_declaration_nr": "tolddeklarationsnummer eller null",
  "im_container": "containernummer",
  "im_plombe": "plombenummer",
  "im_frisk_fisk": "false - true kun hvis forsendelsen indeholder friske fisk",
  "im_member_state_import": "EU-importmedlemsstat og importkontor fx Danmark Aarhus"
}`;

app.post('/api/catch-extract', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API nogle ikke konfigureret.' });

  try {
    const b64Array = req.body.b64Array;
    if (!b64Array || !Array.isArray(b64Array) || b64Array.length === 0) {
      return res.status(400).json({ error: 'Ingen PDF data modtaget.' });
    }

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
          console.log('PDF ' + (i+1) + ': ' + src.getPageCount() + ' sider tilfojet');
        } catch(e) {
          console.log('PDF ' + (i+1) + ' merge fejl (springer over):', e.message);
        }
      }
      const mergedBytes = await mergedPdf.save();
      b64 = Buffer.from(mergedBytes).toString('base64');
      console.log('Merge faerdig: ' + mergedPdf.getPageCount() + ' sider i alt');
    } else {
      b64 = b64Array[0];
    }

    const pdfSizeBytes = Math.round(b64.length * 0.75);
    const pdfSizeMB = (pdfSizeBytes / 1024 / 1024).toFixed(2);
    console.log('CATCH PDF storrelse: ' + pdfSizeMB + ' MB');
    if (pdfSizeBytes > 30 * 1024 * 1024) {
      return res.status(400).json({ error: 'PDF er for stor (' + pdfSizeMB + ' MB). Max 30 MB.' });
    }

    console.log('Kalder Claude for CATCH-udtrak...');
    const rawText = await callClaude(apiKey, b64, CATCH_PROMPT, 4000);
    console.log('Claude svar:', rawText.substring(0, 200));

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

app.get('/api/health', (req, res) => res.json({ status: 'ok', service: 'cw-catch' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('CW-CATCH server koerer paa port ' + PORT));
