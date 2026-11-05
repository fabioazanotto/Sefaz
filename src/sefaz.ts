// Integração com a SEFAZ (serviço NFeDistribuicaoDFe, NT 2014.002 v1.40).
// Só consulta e lê: não envia Ciência da Operação nem qualquer manifestação.
// O certificado e a senha vêm de variáveis de ambiente; nada fica no código.
import https from "node:https";
import tls from "node:tls";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { XMLParser } from "fast-xml-parser";
import type { DocumentoFiscal, ItemNotaFiscal } from "./tipos";

export const NSU_ZERO = "000000000000000";
const LIMITE_RESPOSTA_BYTES = 5 * 1024 * 1024; // resposta inteira
const LIMITE_DOCUMENTO_BYTES = 2 * 1024 * 1024; // cada documento descompactado
const MAX_DOCUMENTOS_POR_LOTE = 50; // limite da NT
const ESPERA_PADRAO_MINUTOS = 65; // a NT exige 1 hora; somamos uma folga

export type ConfigSefaz = {
  url: string;
  caminhoCertificado: string;
  senhaCertificado: string;
  cnpj: string;
  ufAutor: string; // código IBGE da UF do autor, ex.: "35" para SP
  ambiente: 1 | 2; // 1 = produção, 2 = homologação
  caminhoCadeiaConfianca?: string; // opcional: PEM com as raízes ICP-Brasil, se o Node não confiar
};

export type RespostaDistribuicao = {
  cStat: string;
  xMotivo: string;
  ultNSU: string | null;
  maxNSU: string | null;
  documentos: DocumentoFiscal[];
};

// ---------- Pedido ----------

/** Formata o NSU com 15 dígitos. Recusa qualquer valor que não seja número. */
export function formatarNsu(valor: string | number | bigint): string {
  const texto = String(valor).trim();
  if (!/^\d{1,15}$/.test(texto)) throw new Error("NSU inválido: precisa ter só números, até 15 dígitos.");
  return texto.padStart(15, "0");
}

function validarCnpj(cnpj: string): string {
  const limpo = cnpj.replace(/[.\-/\s]/g, "").toUpperCase();
  if (!/^[0-9A-Z]{12}[0-9]{2}$/.test(limpo)) throw new Error("CNPJ inválido: precisa ter 14 caracteres.");
  return limpo;
}

/** Monta o envelope SOAP do pedido distNSU (exemplo 1 da NT, versão 1.01). */
export function montarPedidoDistNsu(config: Pick<ConfigSefaz, "ambiente" | "ufAutor" | "cnpj">, ultNsu: string): string {
  if (!/^\d{2}$/.test(config.ufAutor)) throw new Error("UF do autor inválida: use o código de 2 dígitos (ex.: 35).");
  const cnpj = validarCnpj(config.cnpj);
  const nsu = formatarNsu(ultNsu);
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
    `<soap:Body>` +
    `<nfeDistDFeInteresse xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe">` +
    `<nfeDadosMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe">` +
    `<distDFeInt xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.01">` +
    `<tpAmb>${config.ambiente}</tpAmb><cUFAutor>${config.ufAutor}</cUFAutor><CNPJ>${cnpj}</CNPJ>` +
    `<distNSU><ultNSU>${nsu}</ultNSU></distNSU>` +
    `</distDFeInt></nfeDadosMsg></nfeDistDFeInteresse></soap:Body></soap:Envelope>`
  );
}

// ---------- Leitura da resposta ----------

const leitor = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  parseTagValue: false, // mantém tudo como texto (CNPJ e chave não podem virar número)
  parseAttributeValue: false,
  processEntities: false, // não resolve entidades
  trimValues: true,
});

/** Recusa XML com DOCTYPE ou ENTITY (proteção contra entidades externas) e interpreta o resto. */
export function lerXmlSeguro(xml: string): Record<string, unknown> {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error("XML recusado: contém DOCTYPE ou ENTITY.");
  return leitor.parse(xml) as Record<string, unknown>;
}

function lista<T>(valor: T | T[] | undefined | null): T[] {
  if (valor === undefined || valor === null) return [];
  return Array.isArray(valor) ? valor : [valor];
}

function texto(valor: unknown): string | null {
  if (typeof valor === "string") return valor;
  if (valor && typeof valor === "object" && "#text" in valor) return String((valor as Record<string, unknown>)["#text"]);
  return null;
}

type No = Record<string, unknown>;
const filho = (no: unknown, nome: string): No | undefined => {
  if (no && typeof no === "object") {
    const v = (no as No)[nome];
    if (v && typeof v === "object") return v as No;
  }
  return undefined;
};

/** Descompacta o docZip (base64 + gzip) com limite de tamanho. */
export function descompactarDocZip(base64: string, limiteBytes = LIMITE_DOCUMENTO_BYTES): string {
  const bruto = Buffer.from(base64.replace(/\s+/g, ""), "base64");
  const xml = gunzipSync(bruto, { maxOutputLength: limiteBytes });
  return xml.toString("utf-8");
}

function lerItens(infNFe: No | undefined): ItemNotaFiscal[] {
  return lista(infNFe?.det as No | No[] | undefined).map((det) => {
    const prod = filho(det, "prod");
    return {
      descricao: texto(prod?.xProd) ?? "",
      quantidade: texto(prod?.qCom) ?? "",
      unidade: texto(prod?.uCom) ?? "",
      valorUnitario: texto(prod?.vUnCom) ?? "",
    };
  });
}

/** Converte um documento do lote para o formato interno. Devolve null se não for nota nem evento reconhecível. */
export function converterDocumento(nsu: string, schema: string, xml: string): DocumentoFiscal | null {
  const raiz = lerXmlSeguro(xml);
  if (schema.startsWith("resNFe")) {
    const r = filho(raiz, "resNFe");
    const chave = texto(r?.chNFe);
    if (!r || !chave) return null;
    return {
      chave,
      nsu: formatarNsu(nsu),
      tipo: "resumo",
      fornecedorNome: texto(r.xNome),
      fornecedorCnpj: texto(r.CNPJ) ?? texto(r.CPF),
      valorTotal: texto(r.vNF),
      emitidaEm: texto(r.dhEmi),
      itens: null,
    };
  }
  if (schema.startsWith("procNFe")) {
    const nfeProc = filho(raiz, "nfeProc");
    const infNFe = filho(filho(nfeProc, "NFe"), "infNFe");
    const emit = filho(infNFe, "emit");
    const idAtributo = infNFe ? texto(infNFe["@_Id"]) : null;
    const chave = texto(filho(filho(nfeProc, "protNFe"), "infProt")?.chNFe) ?? idAtributo?.replace(/^NFe/, "") ?? null;
    if (!infNFe || !chave) return null;
    return {
      chave,
      nsu: formatarNsu(nsu),
      tipo: "completa",
      fornecedorNome: texto(emit?.xNome),
      fornecedorCnpj: texto(emit?.CNPJ) ?? texto(emit?.CPF),
      valorTotal: texto(filho(filho(infNFe, "total"), "ICMSTot")?.vNF),
      emitidaEm: texto(filho(infNFe, "ide")?.dhEmi),
      itens: lerItens(infNFe),
    };
  }
  if (schema.startsWith("resEvento") || schema.startsWith("procEvento")) {
    const r = filho(raiz, "resEvento") ?? filho(filho(raiz, "procEventoNFe"), "evento");
    const chave = texto(r?.chNFe) ?? texto(filho(filho(r, "infEvento"), "chNFe") as unknown);
    if (!chave) return null;
    return { chave, nsu: formatarNsu(nsu), tipo: "evento", fornecedorNome: null, fornecedorCnpj: null, valorTotal: null, emitidaEm: null, itens: null };
  }
  return null;
}

/** Lê o envelope SOAP devolvido pela SEFAZ e converte cada docZip. */
export function interpretarResposta(xmlSoap: string): RespostaDistribuicao {
  const raiz = lerXmlSeguro(xmlSoap);
  const ret = filho(filho(filho(filho(raiz, "Envelope"), "Body"), "nfeDistDFeInteresseResponse"), "nfeDistDFeInteresseResult");
  const dados = filho(ret, "retDistDFeInt");
  if (!dados) throw new Error("Resposta inesperada da SEFAZ (sem retDistDFeInt).");
  const zips = lista(filho(dados, "loteDistDFeInt")?.docZip as unknown as (string | No) | (string | No)[] | undefined);
  if (zips.length > MAX_DOCUMENTOS_POR_LOTE) throw new Error("Lote acima do limite de 50 documentos.");
  const documentos: DocumentoFiscal[] = [];
  for (const z of zips) {
    const base64 = texto(z);
    const nsu = typeof z === "object" ? texto(z["@_NSU"]) : null;
    const schema = typeof z === "object" ? texto(z["@_schema"]) : null;
    if (!base64 || !nsu || !schema) continue;
    const doc = converterDocumento(nsu, schema, descompactarDocZip(base64));
    if (doc) documentos.push(doc);
  }
  return {
    cStat: texto(dados.cStat) ?? "",
    xMotivo: texto(dados.xMotivo) ?? "",
    ultNSU: texto(dados.ultNSU),
    maxNSU: texto(dados.maxNSU),
    documentos,
  };
}

// ---------- Estado local (cursor + documentos) ----------

export type EstadoSefaz = {
  ultNSU: string;
  /** Data (ISO) antes da qual não se deve consultar de novo. */
  aguardarAte: string | null;
  documentos: Record<string, DocumentoFiscal>; // chave de acesso -> documento
};

export function estadoInicial(): EstadoSefaz {
  return { ultNSU: NSU_ZERO, aguardarAte: null, documentos: {} };
}

/** Une um documento novo ao que já existe: nunca duplica a chave, e o resumo nunca apaga a nota completa. */
function mesclar(atual: DocumentoFiscal | undefined, novo: DocumentoFiscal): DocumentoFiscal {
  if (!atual) return novo;
  if (atual.tipo === "completa" && novo.tipo !== "completa") return atual;
  return novo;
}

/** Aplica um lote ao estado de uma vez só: documentos e cursor andam juntos. */
export function aplicarLote(estado: EstadoSefaz, resposta: RespostaDistribuicao): EstadoSefaz {
  const documentos = { ...estado.documentos };
  for (const doc of resposta.documentos) {
    // Eventos ficam separados, pois compartilham a chave com a nota.
    const id = doc.tipo === "evento" ? `${doc.chave}#evento#${doc.nsu}` : doc.chave;
    documentos[id] = mesclar(documentos[id], doc);
  }
  const ultNSU = resposta.ultNSU && resposta.ultNSU > estado.ultNSU ? resposta.ultNSU : estado.ultNSU;
  return { ...estado, ultNSU, documentos };
}

export type DecisaoPausa = { parar: boolean; aguardarAte: string | null; motivo: string };

/** Decide se deve parar e até quando esperar, conforme os códigos da NT (itens 3.5 e 3.11.4). */
export function decidirPausa(resposta: RespostaDistribuicao, agora: Date): DecisaoPausa {
  const daqui = (min: number) => new Date(agora.getTime() + min * 60_000).toISOString();
  switch (resposta.cStat) {
    case "138": {
      if (resposta.ultNSU && resposta.maxNSU && resposta.ultNSU === resposta.maxNSU) {
        return { parar: true, aguardarAte: daqui(ESPERA_PADRAO_MINUTOS), motivo: "Todos os documentos disponíveis foram recebidos." };
      }
      return { parar: false, aguardarAte: null, motivo: "Há mais documentos para buscar." };
    }
    case "137":
      return { parar: true, aguardarAte: daqui(ESPERA_PADRAO_MINUTOS), motivo: "Nenhum documento novo. A SEFAZ pede 1 hora antes de consultar de novo." };
    case "656":
      return { parar: true, aguardarAte: daqui(ESPERA_PADRAO_MINUTOS), motivo: "Consumo indevido: o CNPJ ficou bloqueado por 1 hora." };
    case "108":
    case "109":
      return { parar: true, aguardarAte: daqui(30), motivo: "Serviço da SEFAZ parado. Tente mais tarde." };
    default:
      return { parar: true, aguardarAte: null, motivo: `A SEFAZ recusou o pedido (código ${resposta.cStat}): ${resposta.xMotivo}` };
  }
}

// ---------- Conexão ----------

/** Envia o pedido por TLS mútuo, com a validação do servidor sempre ligada. */
export function consultarDistribuicao(config: ConfigSefaz, ultNsu: string): Promise<RespostaDistribuicao> {
  const corpo = montarPedidoDistNsu(config, ultNsu);
  if (Buffer.byteLength(corpo) > 10 * 1024) throw new Error("Pedido acima de 10 KB, limite da NT.");
  const url = new URL(config.url);
  if (url.protocol !== "https:") throw new Error("O endereço da SEFAZ precisa ser https.");
  const opcoes: https.RequestOptions = {
    method: "POST",
    hostname: url.hostname,
    port: url.port || 443,
    path: url.pathname + url.search,
    pfx: readFileSync(config.caminhoCertificado),
    passphrase: config.senhaCertificado,
    rejectUnauthorized: true,
    timeout: 60_000,
    headers: {
      "Content-Type": "text/xml; charset=utf-8",
      "Content-Length": Buffer.byteLength(corpo),
      SOAPAction: "http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe/nfeDistDFeInteresse",
    },
  };
  if (config.caminhoCadeiaConfianca) {
    opcoes.ca = [...tls.rootCertificates, readFileSync(config.caminhoCadeiaConfianca, "utf-8")];
  }
  return new Promise((resolver, rejeitar) => {
    const req = https.request(opcoes, (res) => {
      const partes: Buffer[] = [];
      let total = 0;
      res.on("data", (parte: Buffer) => {
        total += parte.length;
        if (total > LIMITE_RESPOSTA_BYTES) {
          req.destroy(new Error("Resposta da SEFAZ maior que o limite permitido."));
          return;
        }
        partes.push(parte);
      });
      res.on("end", () => {
        const resposta = Buffer.concat(partes).toString("utf-8");
        if (res.statusCode && res.statusCode >= 400 && !resposta.includes("retDistDFeInt")) {
          rejeitar(new Error(`A SEFAZ respondeu com erro HTTP ${res.statusCode}.`));
          return;
        }
        try {
          resolver(interpretarResposta(resposta));
        } catch (erro) {
          rejeitar(erro);
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error("A SEFAZ demorou demais para responder.")));
    req.on("error", rejeitar);
    req.end(corpo);
  });
}
