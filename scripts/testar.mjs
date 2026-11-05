// Teste de consulta de notas na SEFAZ (NFeDistribuicaoDFe). SÓ LEITURA: não envia ciência nem manifestação.
// Rode no seu computador com:  npm run testar
import { existsSync, readFileSync, writeFileSync, renameSync, openSync, closeSync, unlinkSync } from "node:fs";
import {
  aplicarLote,
  consultarDistribuicao,
  decidirPausa,
  estadoInicial,
} from "../src/sefaz.ts";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

const ENDERECO_PADRAO = "https://www1.nfe.fazenda.gov.br/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx";
const faltando = ["SEFAZ_CERT_PATH", "SEFAZ_CERT_SENHA", "SEFAZ_CNPJ"].filter((n) => !process.env[n]);
if (faltando.length) {
  console.error(`Faltam estas configurações no arquivo .env.local: ${faltando.join(", ")}`);
  console.error("Veja o passo a passo que a IA te passou. Nunca escreva a senha no chat.");
  process.exit(1);
}

const config = {
  url: process.env.SEFAZ_URL || ENDERECO_PADRAO,
  caminhoCertificado: process.env.SEFAZ_CERT_PATH,
  senhaCertificado: process.env.SEFAZ_CERT_SENHA,
  cnpj: process.env.SEFAZ_CNPJ,
  ufAutor: process.env.SEFAZ_UF_AUTOR || "35",
  ambiente: process.env.SEFAZ_AMBIENTE === "2" ? 2 : 1,
  caminhoCadeiaConfianca: process.env.SEFAZ_CA_PATH || undefined,
};
const maxLotes = Math.min(Math.max(Number(process.env.SEFAZ_MAX_LOTES) || 1, 1), 3);
const arquivoEstado = process.env.SEFAZ_ARQUIVO_ESTADO || ".sefaz-estado.json";
const arquivoTrava = ".sefaz.lock";

if (!existsSync(config.caminhoCertificado)) {
  console.error("Não encontrei o arquivo do certificado no caminho informado em SEFAZ_CERT_PATH.");
  process.exit(1);
}

const dinheiro = (v) => (v == null ? "—" : Number(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }));
const data = (v) => (v ? new Date(v).toLocaleDateString("pt-BR") : "—");
const hora = (iso) => new Date(iso).toLocaleString("pt-BR");

function lerEstado() {
  if (!existsSync(arquivoEstado)) return estadoInicial();
  return JSON.parse(readFileSync(arquivoEstado, "utf-8"));
}
function salvarEstado(estado) {
  // grava num arquivo temporário e troca de uma vez: documentos e cursor nunca ficam pela metade
  const temp = `${arquivoEstado}.tmp`;
  writeFileSync(temp, JSON.stringify(estado, null, 2));
  renameSync(temp, arquivoEstado);
}

// impede duas execuções ao mesmo tempo
let trava;
try {
  trava = openSync(arquivoTrava, "wx");
} catch {
  console.error(`Já existe uma consulta em andamento (arquivo ${arquivoTrava}). Se tem certeza de que não há, apague esse arquivo.`);
  process.exit(1);
}

let estado = lerEstado();
const novos = [];
try {
  if (estado.aguardarAte && new Date(estado.aguardarAte) > new Date()) {
    console.log(`A SEFAZ pede para esperar. Tente de novo depois de ${hora(estado.aguardarAte)}.`);
    process.exit(0);
  }
  console.log(`Consultando a SEFAZ (${config.ambiente === 1 ? "produção" : "homologação"}), a partir do NSU ${estado.ultNSU}...`);

  for (let lote = 1; lote <= maxLotes; lote++) {
    const resposta = await consultarDistribuicao(config, estado.ultNSU);
    const decisao = decidirPausa(resposta, new Date());
    console.log(`Lote ${lote}: código ${resposta.cStat} — ${resposta.xMotivo}`);

    const antes = new Set(Object.keys(estado.documentos));
    estado = aplicarLote(estado, resposta);
    for (const [id, doc] of Object.entries(estado.documentos)) if (!antes.has(id)) novos.push(doc);

    if (decisao.parar) {
      estado.aguardarAte = decisao.aguardarAte;
      salvarEstado(estado);
      console.log(decisao.motivo);
      if (decisao.aguardarAte) console.log(`Próxima consulta permitida a partir de ${hora(decisao.aguardarAte)}.`);
      break;
    }
    salvarEstado(estado);
    if (lote === maxLotes) console.log("Limite de lotes deste teste atingido. Rode de novo quando quiser continuar.");
  }
} catch (erro) {
  console.error(`Não deu certo: ${erro.message}`);
  const codigo = erro.code ?? "";
  if (/unsupported|mac verify|PKCS12|bad decrypt/i.test(`${erro.message} ${codigo}`))
    console.error("Dica: se a senha está certa, tente  npm run testar:legado  (certificados antigos).");
  if (/UNABLE_TO_VERIFY|SELF_SIGNED|CERT_/i.test(codigo))
    console.error("Dica: o computador não confia no certificado da SEFAZ. Avise a IA; NÃO desligue a verificação.");
  process.exitCode = 1;
} finally {
  closeSync(trava);
  unlinkSync(arquivoTrava);
}

// resumo local
const docs = novos.filter((d) => d.tipo !== "evento");
const eventos = novos.length - docs.length;
console.log(`\nRecebidos agora: ${docs.length} nota(s)${eventos ? ` e ${eventos} evento(s)` : ""}.`);
for (const d of docs)
  console.log(`- [${d.tipo === "completa" ? "nota completa" : "resumo"}] ${d.fornecedorNome ?? "?"} | ${dinheiro(d.valorTotal)} | ${data(d.emitidaEm)}`);
const porFornecedor = new Map();
for (const d of docs) {
  const nome = d.fornecedorNome ?? "?";
  porFornecedor.set(nome, (porFornecedor.get(nome) ?? 0) + Number(d.valorTotal ?? 0));
}
if (porFornecedor.size) {
  console.log("\nTotal por fornecedor:");
  for (const [nome, total] of porFornecedor) console.log(`- ${nome}: ${dinheiro(total)}`);
  console.log("\nObs.: 'resumo' não traz os produtos. Só a nota completa traz os itens.");
}
