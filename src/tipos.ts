// Formato interno dos documentos fiscais devolvidos pelo módulo da SEFAZ.

/** "resumo" = só os dados básicos; "completa" = XML da nota com os itens; "evento" = manifestação, cancelamento etc. */
export type TipoDocumentoFiscal = "resumo" | "completa" | "evento";

export type ItemNotaFiscal = {
  descricao: string;
  quantidade: string;
  unidade: string;
  valorUnitario: string;
};

export type DocumentoFiscal = {
  chave: string; // chave de acesso (44 caracteres)
  nsu: string; // número sequencial da SEFAZ (15 dígitos)
  tipo: TipoDocumentoFiscal;
  fornecedorNome: string | null;
  fornecedorCnpj: string | null; // texto, pois o CNPJ pode ter letras
  valorTotal: string | null; // "123.45", como veio no XML
  emitidaEm: string | null; // data e hora de emissão, como veio no XML
  itens: ItemNotaFiscal[] | null; // só existe na nota completa
};
