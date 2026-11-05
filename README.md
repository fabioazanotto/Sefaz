# Sefaz · teste de leitura de notas de compra

Teste para ver se as notas fiscais de compra (NF-e) do **BlackPoke Santos** chegam direto da SEFAZ,
usando o certificado digital A1 da empresa. Este projeto é independente do app de escala.

**Só leitura.** Não emite, não cancela e **não envia Ciência da Operação** nem qualquer manifestação.
Quem decide sobre manifestação é o responsável fiscal (contador).

## O que ele faz
- Consulta o serviço `NFeDistribuicaoDFe` (Nota Técnica 2014.002 v1.40) por NSU, de 15 dígitos.
- Guarda o último NSU junto com os documentos num arquivo local (`.sefaz-estado.json`), sem duplicar pela chave de acesso.
- Para sozinho em `137` (nada novo), `656` (consumo indevido) e quando `ultNSU` iguala `maxNSU`, e diz quando pode tentar de novo (mais de 1 hora).
- Diferencia **resumo** (fornecedor, valor, data; sem produtos) de **nota completa** (com itens).

## Antes de começar
1. Node.js 22.18 ou mais novo (`node -v`).
2. Certificado A1 (`.pfx`) guardado **fora desta pasta**, por exemplo em `C:\certificado\`.
3. Avise o contador: se o app dele já baixa as notas desse CNPJ, as consultas precisam seguir a mesma sequência de NSU, senão a SEFAZ bloqueia por 1 hora.

## Passo a passo (Windows)
1. Abra o Prompt de Comando dentro desta pasta e rode:
   ```
   npm install
   ```
2. Copie `.env.example` para `.env.local` e preencha `SEFAZ_CERT_PATH`, `SEFAZ_CERT_SENHA` e `SEFAZ_CNPJ` (CNPJ de Santos, só números).
3. Rode o teste (uma consulta por vez):
   ```
   npm run testar
   ```

## Se der erro
| Mensagem | O que fazer |
| --- | --- |
| "unsupported", "PKCS12", "mac verify" | Confira a senha. Se estiver certa, rode `npm run testar:legado` (certificado antigo). |
| Erro de confiança no certificado da SEFAZ | Não desligue a verificação. Informe o `SEFAZ_CA_PATH` com as raízes ICP-Brasil, ou peça ajuda. |
| Código `137` | Normal no primeiro acesso. Espere mais de 1 hora (o script avisa quando). |
| Código `656` | O CNPJ ficou bloqueado por 1 hora. Espere. |
| Código `593` | O certificado e o CNPJ informado não têm a mesma raiz (8 primeiros dígitos). |

## Verificações do código
```
npm test
npm run tipos
```

## Segurança
- Certificado, senha e `.env.local` nunca entram no Git (veja `.gitignore`).
- A validação TLS fica sempre ligada.
- Não cole certificado, senha nem XML de notas em chats ou prints.
- Os XMLs recebidos ficam só em `.sefaz-estado.json`, na sua máquina.
