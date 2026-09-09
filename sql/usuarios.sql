WITH USR_DIRETORIA AS (
    SELECT
        F.NOMEFUNCIONARIO nome,
        '05507218000150' filial,
        'MATRIZ' filial_nome,
        'RJ' filial_estado,
        'RIO DE JANEIRO' filial_cidade,
        'GERAL' filial_regional,
        F.CPF documento,
        'DIRETORIA' cargo,
        CAST(NULL AS VARCHAR(14)) responsavel
    FROM FUNCIONARIO F
    WHERE F.STATUS = 'A'
      AND F.IDFUNCIONARIO IN (147, 209, 691, 223, 752)
),
USR_SUPERVISOR AS (
    SELECT
        F.NOMEFUNCIONARIO nome,
        '05507218000150' filial,
        'MATRIZ' filial_nome,
        'RJ' filial_estado,
        'RIO DE JANEIRO' filial_cidade,
        SUBSTRING(F.NOMEFUNCIONARIO FROM 1 FOR POSITION(' ', F.NOMEFUNCIONARIO, 1)) filial_regional,
        F.CPF documento,
        'SUPERVISOR' cargo,
        '12447430794' responsavel
    FROM FUNCIONARIO F
    WHERE F.STATUS = 'A'
      AND F.IDFUNCIONARIO IN (142, 714, 143, 1581)
),
USR_GERENTE AS (
    SELECT
        F.NOMEFUNCIONARIO nome,
        FL.CGC filial,
        FL.NOMEFILIAL filial_nome,
        FL.UF filial_estado,
        FL.CIDADE filial_cidade,
        SUBSTRING(SU.NOMEFUNCIONARIO FROM 1 FOR POSITION(' ', SU.NOMEFUNCIONARIO, 1)) filial_regional,
        F.CPF documento,
        'GERENTE DE LOJA' cargo,
        SU.CPF responsavel
    FROM FUNCIONARIO F
    JOIN FILIAL FL ON FL.IDFILIAL = F.IDFILIAL
    JOIN FUNCIONARIO SU ON SU.IDFUNCIONARIO = FL.IDSUPERVISOR
    WHERE F.STATUS = 'A'
      AND F.CATEGORIA = 'GR'
      AND F.NOMEFUNCIONARIO NOT LIKE '%GERENTE%'
      AND F.NOMEFUNCIONARIO NOT LIKE 'GR%'
),
USR_VENDEDOR AS (
    SELECT
        F.NOMEFUNCIONARIO nome,
        FL.CGC filial,
        FL.NOMEFILIAL filial_nome,
        FL.UF filial_estado,
        FL.CIDADE filial_cidade,
        SUBSTRING(SU.NOMEFUNCIONARIO FROM 1 FOR POSITION(' ', SU.NOMEFUNCIONARIO, 1)) filial_regional,
        F.CPF documento,
        'VENDEDOR' cargo,
        GR.CPF responsavel
    FROM FUNCIONARIO F
    JOIN FILIAL FL ON FL.IDFILIAL = F.IDFILIAL
    JOIN FUNCIONARIO GR
      ON GR.IDFILIAL = F.IDFILIAL
     AND GR.STATUS = 'A'
     AND GR.CATEGORIA = 'GR'
     AND GR.NOMEFUNCIONARIO NOT LIKE '%GERENTE%'
     AND GR.NOMEFUNCIONARIO NOT LIKE 'GR%'
    JOIN FUNCIONARIO SU ON SU.IDFUNCIONARIO = FL.IDSUPERVISOR
    WHERE F.STATUS = 'A'
      AND F.CATEGORIA = 'VD'
      AND F.NOMEFUNCIONARIO NOT LIKE '%VENDEDOR%'
),
USUARIOS AS (
    SELECT
        DI.nome,
        DI.filial,
        DI.filial_nome,
        DI.filial_estado,
        DI.filial_cidade,
        DI.filial_regional,
        DI.documento,
        DI.cargo,
        DI.responsavel
    FROM USR_DIRETORIA DI

    UNION ALL

    SELECT
        SU.nome,
        SU.filial,
        SU.filial_nome,
        SU.filial_estado,
        SU.filial_cidade,
        SU.filial_regional,
        SU.documento,
        SU.cargo,
        SU.responsavel
    FROM USR_SUPERVISOR SU
    JOIN USR_DIRETORIA DI ON SU.RESPONSAVEL = DI.DOCUMENTO

    UNION ALL

    SELECT
        GR.nome,
        GR.filial,
        GR.filial_nome,
        GR.filial_estado,
        GR.filial_cidade,
        GR.filial_regional,
        GR.documento,
        GR.cargo,
        GR.responsavel
    FROM USR_GERENTE GR
    JOIN USR_SUPERVISOR SU ON GR.RESPONSAVEL = SU.DOCUMENTO

    UNION ALL

    SELECT
        VD.nome,
        VD.filial,
        VD.filial_nome,
        VD.filial_estado,
        VD.filial_cidade,
        VD.filial_regional,
        VD.documento,
        VD.cargo,
        VD.responsavel
    FROM USR_VENDEDOR VD
    JOIN USR_GERENTE GR ON VD.RESPONSAVEL = GR.DOCUMENTO
)
SELECT
    U.nome,
    U.filial,
    U.filial_nome,
    U.filial_estado,
    U.filial_cidade,
    U.filial_regional,
    U.documento,
    U.cargo,
    U.responsavel
FROM USUARIOS U
WHERE U.DOCUMENTO IS NOT NULL
