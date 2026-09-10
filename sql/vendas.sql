WITH VENDAS AS (
    SELECT
        F.IDFILIAL,
        CAST(F.CGC AS VARCHAR(20)) filial_cnpj,
        CAST(S.NUMEROSAIDA AS VARCHAR(50)) pedido_id,
        CAST(L.NUMERONF AS VARCHAR(50)) nota_numero,
        SUBSTRING(CAST(S.DATASAIDA AS VARCHAR(24)) FROM 1 FOR 19) pedido_data_venda,
        CAST(COALESCE(V.CPF, VE.DOCUMENTO) AS VARCHAR(20)) vendedor,
        CAST(I.IDPRODUTO AS VARCHAR(50)) produto_id,
        CAST(P.EAN AS VARCHAR(50)) produto_ean,
        I.QTDE produto_qtd,
        I.PUNIT + COALESCE(I.VALORDESCONTO, 0) produto_valor,
        COALESCE(I.VALORDESCONTO, 0) produto_desconto
    FROM SAIDA S
    JOIN ITEMSAIDA I
      ON I.IDFILIAL = S.IDFILIAL
     AND I.NUMEROSAIDA = S.NUMEROSAIDA
    JOIN FILIAL F ON F.IDFILIAL = S.IDFILIAL
    JOIN FUNCIONARIO V ON V.IDVENDEDOR = S.IDVENDEDOR
    JOIN PRODUTO P ON P.IDPRODUTO = I.IDPRODUTO
    JOIN VENDEDOR VE ON VE.IDVENDEDOR = S.IDVENDEDOR
    LEFT JOIN LFNF L
      ON L.IDFILIAL = S.IDFILIAL
     AND L.NUMEROORIGEM = S.NUMEROSAIDA
     AND L.TIPOLF = 'S'
     AND L.STATUS = 'A'
    WHERE S.STATUS = 'A'
      AND S.TIPOSAIDA IN ('1', '2', '9')
      AND S.DATASAIDA >= CAST(:date_start AS TIMESTAMP)
      AND S.DATASAIDA < CAST(:date_end_exclusive AS TIMESTAMP)
      AND NOT (I.QTDE - COALESCE(I.QTDEDEVOLVIDA, 0)) = 0
      AND P.SERVICO <> 'T'
      AND S.IDFILIAL NOT IN ('16')
)
SELECT
    V.IDFILIAL,
    V.filial_cnpj,
    V.pedido_id,
    V.nota_numero,
    V.pedido_data_venda,
    V.vendedor,
    V.produto_id,
    V.produto_ean,
    V.produto_valor,
    V.produto_desconto,
    SUM(V.produto_qtd) produto_qtd
FROM VENDAS V
WHERE V.VENDEDOR IS NOT NULL
GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9, 10
