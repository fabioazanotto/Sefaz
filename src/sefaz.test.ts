import { describe, expect, it } from "vitest";
import { gzipSync } from "node:zlib";
import {
  NSU_ZERO,
  aplicarLote,
  decidirPausa,
  descompactarDocZip,
  estadoInicial,
  formatarNsu,
  interpretarResposta,
  lerXmlSeguro,
  montarPedidoDistNsu,
} from "./sefaz";

// Todos os dados abaixo são inventados.
const CHAVE_A = "35260100000000000191550010000000011000000011";
const CHAVE_B = "35260100000000000191550010000000021000000022";

const zip = (xml: string) => gzipSync(Buffer.from(xml, "utf-8")).toString("base64");

const resNFe = (chave: string) =>
  `<resNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.01"><chNFe>${chave}</chNFe><CNPJ>00000000000191</CNPJ>` +
  `<xNome>Fornecedor Ficticio Ltda</xNome><IE>123</IE><dhEmi>2026-11-03T10:00:00-03:00</dhEmi><tpNF>1</tpNF>` +
  `<vNF>150.50</vNF><digVal>x</digVal><dhRecbto>2026-11-03T10:05:00-03:00</dhRecbto><nProt>1</nProt><cSitNFe>1</cSitNFe></resNFe>`;

const procNFe = (chave: string) =>
  `<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00"><NFe><infNFe Id="NFe${chave}">` +
  `<ide><dhEmi>2026-11-03T10:00:00-03:00</dhEmi></ide>` +
  `<emit><CNPJ>00000000000191</CNPJ><xNome>Fornecedor Ficticio Ltda</xNome></emit>` +
  `<det nItem="1"><prod><xProd>Salmao</xProd><uCom>KG</uCom><qCom>10.0000</qCom><vUnCom>60.0000</vUnCom></prod></det>` +
  `<det nItem="2"><prod><xProd>Arroz</xProd><uCom>KG</uCom><qCom>5.0000</qCom><vUnCom>10.0000</vUnCom></prod></det>` +
  `<total><ICMSTot><vNF>650.00</vNF></ICMSTot></total></infNFe></NFe>` +
  `<protNFe><infProt><chNFe>${chave}</chNFe></infProt></protNFe></nfeProc>`;

function envelope(cStat: string, ultNSU: string, maxNSU: string, docs: { nsu: string; schema: string; xml: string }[] = []) {
  const lote = docs.length
    ? `<loteDistDFeInt>${docs.map((d) => `<docZip NSU="${d.nsu}" schema="${d.schema}">${zip(d.xml)}</docZip>`).join("")}</loteDistDFeInt>`
    : "";
  return (
    `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>` +
    `<nfeDistDFeInteresseResponse xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe"><nfeDistDFeInteresseResult>` +
    `<retDistDFeInt xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.01"><tpAmb>1</tpAmb><verAplic>1.4.0</verAplic>` +
    `<cStat>${cStat}</cStat><xMotivo>teste</xMotivo><dhResp>2026-11-05T10:00:00-03:00</dhResp>` +
    `<ultNSU>${ultNSU}</ultNSU><maxNSU>${maxNSU}</maxNSU>${lote}</retDistDFeInt>` +
    `</nfeDistDFeInteresseResult></nfeDistDFeInteresseResponse></soap:Body></soap:Envelope>`
  );
}

describe("pedido", () => {
  it("monta o pedido distNSU com NSU de 15 dígitos", () => {
    const xml = montarPedidoDistNsu({ ambiente: 1, ufAutor: "35", cnpj: "00.000.000/0001-91" }, "42");
    expect(xml).toContain("<tpAmb>1</tpAmb>");
    expect(xml).toContain("<cUFAutor>35</cUFAutor>");
    expect(xml).toContain("<CNPJ>00000000000191</CNPJ>");
    expect(xml).toContain("<ultNSU>000000000000042</ultNSU>");
    expect(Buffer.byteLength(xml)).toBeLessThan(10 * 1024);
  });

  it("recusa NSU e CNPJ inválidos", () => {
    expect(() => formatarNsu("12a")).toThrow();
    expect(() => formatarNsu("1234567890123456")).toThrow();
    expect(() => montarPedidoDistNsu({ ambiente: 1, ufAutor: "35", cnpj: "123" }, NSU_ZERO)).toThrow();
    expect(() => montarPedidoDistNsu({ ambiente: 1, ufAutor: "SP", cnpj: "00000000000191" }, NSU_ZERO)).toThrow();
  });

  it("aceita CNPJ alfanumérico", () => {
    const xml = montarPedidoDistNsu({ ambiente: 2, ufAutor: "35", cnpj: "12ABC34501DE35" }, NSU_ZERO);
    expect(xml).toContain("<CNPJ>12ABC34501DE35</CNPJ>");
  });
});

describe("resposta", () => {
  it("diferencia resumo de nota completa e mantém o CNPJ como texto", () => {
    const r = interpretarResposta(
      envelope("138", "000000000000002", "000000000000002", [
        { nsu: "000000000000001", schema: "resNFe_v1.01.xsd", xml: resNFe(CHAVE_A) },
        { nsu: "000000000000002", schema: "procNFe_v4.00.xsd", xml: procNFe(CHAVE_B) },
      ]),
    );
    expect(r.cStat).toBe("138");
    expect(r.documentos).toHaveLength(2);
    const [resumo, completa] = r.documentos;
    expect(resumo).toMatchObject({ tipo: "resumo", chave: CHAVE_A, fornecedorCnpj: "00000000000191", valorTotal: "150.50", itens: null });
    expect(completa).toMatchObject({ tipo: "completa", chave: CHAVE_B, valorTotal: "650.00" });
    expect(completa.itens).toHaveLength(2);
    expect(completa.itens?.[0]).toMatchObject({ descricao: "Salmao", quantidade: "10.0000" });
  });

  it("lê resposta sem documentos (137)", () => {
    const r = interpretarResposta(envelope("137", NSU_ZERO, NSU_ZERO));
    expect(r.cStat).toBe("137");
    expect(r.documentos).toEqual([]);
  });

  it("recusa XML com DOCTYPE/ENTITY", () => {
    expect(() => lerXmlSeguro(`<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><x>&e;</x>`)).toThrow(/recusado/);
  });

  it("respeita o limite de tamanho ao descompactar", () => {
    const enorme = zip("a".repeat(5000));
    expect(() => descompactarDocZip(enorme, 1000)).toThrow();
    expect(descompactarDocZip(zip("ok"), 1000)).toBe("ok");
  });
});

describe("cursor e documentos", () => {
  const lote1 = interpretarResposta(
    envelope("138", "000000000000001", "000000000000002", [{ nsu: "000000000000001", schema: "resNFe_v1.01.xsd", xml: resNFe(CHAVE_A) }]),
  );

  it("avança o cursor junto com os documentos", () => {
    const e = aplicarLote(estadoInicial(), lote1);
    expect(e.ultNSU).toBe("000000000000001");
    expect(Object.keys(e.documentos)).toEqual([CHAVE_A]);
  });

  it("não duplica a chave ao repetir o lote", () => {
    const e = aplicarLote(aplicarLote(estadoInicial(), lote1), lote1);
    expect(Object.keys(e.documentos)).toHaveLength(1);
  });

  it("resumo não apaga a nota completa, e a completa substitui o resumo", () => {
    const completa = interpretarResposta(
      envelope("138", "000000000000003", "000000000000003", [{ nsu: "000000000000003", schema: "procNFe_v4.00.xsd", xml: procNFe(CHAVE_A) }]),
    );
    const comCompleta = aplicarLote(aplicarLote(estadoInicial(), lote1), completa);
    expect(comCompleta.documentos[CHAVE_A].tipo).toBe("completa");
    const depoisResumo = aplicarLote(comCompleta, lote1);
    expect(depoisResumo.documentos[CHAVE_A].tipo).toBe("completa");
    expect(depoisResumo.ultNSU).toBe("000000000000003"); // o cursor nunca volta
  });
});

describe("pausas", () => {
  const agora = new Date("2026-11-05T12:00:00Z");
  const r = (cStat: string, ult = NSU_ZERO, max = NSU_ZERO) => ({ cStat, xMotivo: "", ultNSU: ult, maxNSU: max, documentos: [] });

  it("137 e 656 pedem mais de 1 hora de espera", () => {
    for (const c of ["137", "656"]) {
      const d = decidirPausa(r(c), agora);
      expect(d.parar).toBe(true);
      expect(new Date(d.aguardarAte!).getTime() - agora.getTime()).toBeGreaterThanOrEqual(60 * 60_000);
    }
  });

  it("138 continua enquanto ultNSU for menor que maxNSU e para quando igualar", () => {
    expect(decidirPausa(r("138", "000000000000001", "000000000000002"), agora).parar).toBe(false);
    const fim = decidirPausa(r("138", "000000000000002", "000000000000002"), agora);
    expect(fim.parar).toBe(true);
    expect(fim.aguardarAte).not.toBeNull();
  });

  it("outros códigos param sem repetir", () => {
    const d = decidirPausa(r("593"), agora);
    expect(d.parar).toBe(true);
    expect(d.motivo).toContain("593");
  });
});
