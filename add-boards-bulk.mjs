// add-boards-bulk.mjs — script puntual, LOCAL, no forma parte de la app (no se commitea).
// Añade y verifica boards del catálogo en bloque, usando las propias funciones
// de la app (addBoard + verifyBoard): un board solo queda guardado si la
// llamada real a su ATS devuelve ofertas. Lo que falla NO se guarda.
//
// Uso (en Windows, desde la carpeta del proyecto, con el servidor DETENIDO):
//   node add-boards-bulk.mjs
//   node add-boards-bulk.mjs data\agentv2.db
// Sin argumento usa ./data/agentv2.db. Requiere Node 24 (node:sqlite, stdlib).
// El script se puede volver a ejecutar: los boards ya existentes y verificados
// se saltan, y los que fallaron se reintentan (no duplica nada).
//
// Lista verificada en vivo el 2026-10-31 contra las APIs públicas de
// Greenhouse y Lever (HTTP 200 + array de ofertas no vacío). 5 slugs de Lever
// NO podrán entrar por la regla de slugs de la app (/^[a-z0-9][a-z0-9-]*$/,
// sin mayúsculas ni puntos): BTSE, Flex, EnaraHealth, AIFund y wahed.com.
// El script los intentará igualmente y los reportará como rechazados, sin
// inventar un slug alternativo. Para esos 5 haría falta cambiar la regla
// de slugs en el código (no incluido aquí).

import { openDatabase } from "./packages/shared/db.mjs";
import {
  addBoard,
  verifyBoard,
  deleteBoard,
  getBoardByAtsBoard,
} from "./packages/shared/company-catalog.mjs";

const dbPath = process.argv[2] || "data/agentv2.db";

const BOARDS = [
  // Greenhouse — 50
  { company: "Stripe", ats: "greenhouse", board: "stripe" },
  { company: "Figma", ats: "greenhouse", board: "figma" },
  { company: "Anthropic", ats: "greenhouse", board: "anthropic" },
  { company: "BRKZ", ats: "greenhouse", board: "brkz" },
  { company: "Axi", ats: "greenhouse", board: "axicorpfinancialservicesptyltd" },
  { company: "CFO Insights", ats: "greenhouse", board: "cfoinsights" },
  { company: "Connected Cannabis", ats: "greenhouse", board: "connectedcannabis" },
  { company: "Madano", ats: "greenhouse", board: "madano" },
  { company: "Broadsign", ats: "greenhouse", board: "broadsign" },
  { company: "IFT", ats: "greenhouse", board: "iftother" },
  { company: "RTB House", ats: "greenhouse", board: "rtbhouse" },
  { company: "Tide", ats: "greenhouse", board: "tide" },
  { company: "Airbnb", ats: "greenhouse", board: "airbnb" },
  { company: "Coinbase", ats: "greenhouse", board: "coinbase" },
  { company: "Dropbox", ats: "greenhouse", board: "dropbox" },
  { company: "Datadog", ats: "greenhouse", board: "datadog" },
  { company: "Cloudflare", ats: "greenhouse", board: "cloudflare" },
  { company: "GitLab", ats: "greenhouse", board: "gitlab" },
  { company: "Discord", ats: "greenhouse", board: "discord" },
  { company: "Robinhood", ats: "greenhouse", board: "robinhood" },
  { company: "Asana", ats: "greenhouse", board: "asana" },
  { company: "Databricks", ats: "greenhouse", board: "databricks" },
  { company: "Twilio", ats: "greenhouse", board: "twilio" },
  { company: "Airtable", ats: "greenhouse", board: "airtable" },
  { company: "Duolingo", ats: "greenhouse", board: "duolingo" },
  { company: "Coursera", ats: "greenhouse", board: "coursera" },
  { company: "Instacart", ats: "greenhouse", board: "instacart" },
  { company: "Affirm", ats: "greenhouse", board: "affirm" },
  { company: "SoFi", ats: "greenhouse", board: "sofi" },
  // OJO: este board NO es Wise la fintech; es Wise Worksite Field Sales.
  { company: "Wise Worksite Field Sales", ats: "greenhouse", board: "wise" },
  { company: "Monzo", ats: "greenhouse", board: "monzo" },
  { company: "Block", ats: "greenhouse", board: "block" },
  { company: "Toast", ats: "greenhouse", board: "toast" },
  { company: "Pinterest", ats: "greenhouse", board: "pinterest" },
  { company: "Elastic", ats: "greenhouse", board: "elastic" },
  { company: "MongoDB", ats: "greenhouse", board: "mongodb" },
  { company: "Mozilla", ats: "greenhouse", board: "mozilla" },
  { company: "Intercom", ats: "greenhouse", board: "intercom" },
  { company: "Mixpanel", ats: "greenhouse", board: "mixpanel" },
  { company: "LaunchDarkly", ats: "greenhouse", board: "launchdarkly" },
  { company: "Fastly", ats: "greenhouse", board: "fastly" },
  { company: "Squarespace", ats: "greenhouse", board: "squarespace" },
  { company: "Adyen", ats: "greenhouse", board: "adyen" },
  { company: "Vercel", ats: "greenhouse", board: "vercel" },
  { company: "Lyft", ats: "greenhouse", board: "lyft" },
  { company: "Reddit", ats: "greenhouse", board: "reddit" },
  // OJO: este board NO es Remote.com; es el board de empleos remotos de General Assembly.
  { company: "General Assembly Remote Jobs", ats: "greenhouse", board: "remote" },
  { company: "Brex", ats: "greenhouse", board: "brex" },
  { company: "Mercury", ats: "greenhouse", board: "mercury" },
  { company: "Gusto", ats: "greenhouse", board: "gusto" },
  // Lever — 50
  { company: "Palantir", ats: "lever", board: "palantir" },
  { company: "Murgado Automotive Group", ats: "lever", board: "murgadoautomotive" },
  { company: "Spotify", ats: "lever", board: "spotify" },
  { company: "Pigment", ats: "lever", board: "pigment" },
  { company: "Aleph", ats: "lever", board: "aleph" },
  { company: "Sophos", ats: "lever", board: "sophos" },
  { company: "Saviynt", ats: "lever", board: "saviynt" },
  { company: "Paytm", ats: "lever", board: "paytm" },
  { company: "JumpCloud", ats: "lever", board: "jumpcloud" },
  { company: "FloQast", ats: "lever", board: "floqast" },
  { company: "Everbridge", ats: "lever", board: "everbridge" },
  { company: "Apryse", ats: "lever", board: "apryse" },
  { company: "Contentsquare", ats: "lever", board: "contentsquare" },
  { company: "Iru", ats: "lever", board: "iru" },
  { company: "Matillion", ats: "lever", board: "matillion" },
  { company: "Agicap", ats: "lever", board: "agicap" },
  { company: "Insider One", ats: "lever", board: "insiderone" },
  { company: "TTEC Digital", ats: "lever", board: "ttecdigital" },
  { company: "Canary Technologies", ats: "lever", board: "canarytechnologies" },
  { company: "Cirque du Soleil", ats: "lever", board: "cirquedusoleil" },
  { company: "Flynn Group of Companies", ats: "lever", board: "flynncompanies" },
  { company: "Pattern", ats: "lever", board: "pattern" },
  { company: "AngelList", ats: "lever", board: "angellist" },
  { company: "Xsolla", ats: "lever", board: "xsolla" },
  { company: "Swiftly", ats: "lever", board: "goswift" },
  { company: "Firework", ats: "lever", board: "fireworkhq" },
  { company: "Everlywell", ats: "lever", board: "everlywell" },
  { company: "Noodle", ats: "lever", board: "noodle" },
  { company: "Gridware", ats: "lever", board: "gridware" },
  { company: "Tagup", ats: "lever", board: "tagup" },
  { company: "Voltus", ats: "lever", board: "voltus" },
  { company: "e.l.f. Beauty", ats: "lever", board: "elfbeauty" },
  { company: "Unlimit", ats: "lever", board: "unlimit" },
  // Estos 5 slugs usan mayúsculas o punto y la regla de slugs de la app los
  // rechazará (se reportan como rechazados, no se inventa alternativa):
  { company: "BTSE", ats: "lever", board: "BTSE" },
  { company: "ION Group", ats: "lever", board: "ion" },
  { company: "Fun.xyz", ats: "lever", board: "funxyz" },
  { company: "Wahed", ats: "lever", board: "wahed.com" },
  { company: "Addition Wealth", ats: "lever", board: "additionwealth" },
  { company: "Flex", ats: "lever", board: "Flex" },
  { company: "DearDoc", ats: "lever", board: "getdeardoc" },
  { company: "Transmutex", ats: "lever", board: "transmutex" },
  { company: "Foundation EGI", ats: "lever", board: "foundation-llm-technologies" },
  { company: "Worldscape", ats: "lever", board: "worldscape-technology" },
  { company: "Robust AI", ats: "lever", board: "robust-ai" },
  { company: "Enara Health", ats: "lever", board: "EnaraHealth" },
  { company: "Atom Computing", ats: "lever", board: "atomcomputing" },
  { company: "AI Fund", ats: "lever", board: "AIFund" },
  { company: "Duranta", ats: "lever", board: "getduranta" },
  { company: "Waabi", ats: "lever", board: "waabi" },
  { company: "AHEAD", ats: "lever", board: "thinkahead" },
];

const counts = {
  verified: 0,
  alreadyVerified: 0,
  alreadyUnverifiedVerifiedNow: 0,
  rejectedSlug: 0,
  verifyFailed: 0,
};

// Utilidad para probar con pocos boards: BOARDS_LIMIT=3 node add-boards-bulk.mjs
const boardsLimit = Number(process.env.BOARDS_LIMIT || 0);
const LIST = boardsLimit > 0 ? BOARDS.slice(0, boardsLimit) : BOARDS;

const db = openDatabase(dbPath);
console.log(`Base de datos: ${dbPath}`);
console.log(`Boards en la lista: ${LIST.length}`);
for (const b of LIST) {
  const label = `${b.company} (${b.ats}/${b.board})`;
  try {
    const existing = getBoardByAtsBoard(db, b.ats, b.board);
    if (existing) {
      if (existing.verified_at) {
        counts.alreadyVerified += 1;
        console.log(`- YA EXISTE Y VERIFICADA, se deja: ${label}`);
        continue;
      }
      const v = await verifyBoard(db, existing.id);
      if (v.ok) {
        counts.alreadyUnverifiedVerifiedNow += 1;
        console.log(`- YA EXISTÍA SIN VERIFICAR, ahora verificada: ${label}`);
      } else {
        counts.verifyFailed += 1;
        console.log(`- YA EXISTÍA SIN VERIFICAR, sigue sin verificar (${v.reason || v.cause || "sin motivo"}): ${label}`);
      }
      continue;
    }
    let row;
    try {
      row = addBoard(db, { company: b.company, ats: b.ats, board: b.board });
    } catch (err) {
      counts.rejectedSlug += 1;
      console.log(`- RECHAZADA (no se guarda): ${label} — ${err.message}`);
      continue;
    }
    const v = await verifyBoard(db, row.id);
    if (v.ok) {
      counts.verified += 1;
      console.log(`- VERIFICADA Y GUARDADA: ${label}`);
    } else {
      // No dejamos filas inservibles: si la verificación falla, se borra
      // la fila recién creada. Volver a ejecutar el script lo reintenta.
      deleteBoard(db, row.id);
      counts.verifyFailed += 1;
      console.log(`- NO GUARDADA (verificación fallida: ${v.reason || v.cause || "sin motivo"}): ${label}`);
    }
  } catch (err) {
    counts.verifyFailed += 1;
    console.log(`- ERROR INESPERADO (no se guarda): ${label} — ${err.message}`);
  }
}
console.log("");
console.log("Resumen:");
console.log(`  Nuevas verificadas y guardadas: ${counts.verified}`);
console.log(`  Ya existían y verificadas (sin cambios): ${counts.alreadyVerified}`);
console.log(`  Ya existían sin verificar y ahora verificadas: ${counts.alreadyUnverifiedVerifiedNow}`);
console.log(`  Rechazadas por la regla de slugs (no guardadas): ${counts.rejectedSlug}`);
console.log(`  Verificación fallida (no guardadas): ${counts.verifyFailed}`);
console.log("Hecho. Arranca el servidor de nuevo con npm start.");
db.close();
