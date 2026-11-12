require("dotenv").config();

const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const path = require("path");
const sql = require("mssql");

const app = express();

app.use(helmet({
  contentSecurityPolicy: false
}));
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const PORT = Number(process.env.PORT || 3000);

const sourceConfig = {
  server: process.env.SOURCE_DB_SERVER,
  port: Number(process.env.SOURCE_DB_PORT || 1433),
  database: process.env.SOURCE_DB_DATABASE,
  user: process.env.SOURCE_DB_USER,
  password: process.env.SOURCE_DB_PASSWORD,
  options: {
    encrypt: String(process.env.SOURCE_DB_ENCRYPT).toLowerCase() === "true",
    trustServerCertificate:
      String(process.env.SOURCE_DB_TRUST_SERVER_CERT).toLowerCase() !== "false"
  },
  pool: { max: 5, min: 0, idleTimeoutMillis: 30000 }
};

const targetConfig = {
  server: process.env.TARGET_DB_SERVER,
  port: Number(process.env.TARGET_DB_PORT || 1433),
  database: process.env.TARGET_DB_DATABASE,
  user: process.env.TARGET_DB_USER,
  password: process.env.TARGET_DB_PASSWORD,
  options: {
    encrypt: String(process.env.TARGET_DB_ENCRYPT).toLowerCase() === "true",
    trustServerCertificate:
      String(process.env.TARGET_DB_TRUST_SERVER_CERT).toLowerCase() !== "false"
  },
  pool: { max: 10, min: 0, idleTimeoutMillis: 30000 }
};

let sourcePool;
let targetPool;

const SOURCE_QUERY = `
SELECT
    VO.ORDERID AS PLANEACION,
    CAST(VO.ADDDATE AS DATE) AS FECHA_CARGA,
    SUM(CAST(VO.QTYORIGINAL AS INT)) AS PZ_PEDIDAS,
    SUM(CAST(VO.QTYSHIPPED AS INT)) AS PZ_ENVIADAS,
    OB.EDITDATE AS ULTIMA_EDICION,
    OB.EDITUSER AS USUARIO_EDITA,
    VO.STATUS
FROM [SCEIM].[dbo].[vOUTBOUNDORDETAIL] AS VO
LEFT JOIN SCEIM.dbo.vOutboundOrderHeader AS OB
    ON VO.ORDERID = OB.ORDERID
WHERE VO.CONSIGNEE = 'CHEFMAN'
  AND VO.ADDDATE >= @fromDate
GROUP BY
    VO.ORDERID,
    CAST(VO.ADDDATE AS DATE),
    CAST(OB.SCHEDULEDDATE AS nvarchar),
    OB.EDITDATE,
    OB.EDITUSER,
    VO.STATUS
ORDER BY VO.ORDERID;
`;

async function getSourcePool() {
  if (!sourcePool) sourcePool = await sql.connect(sourceConfig);
  return sourcePool;
}

async function getTargetPool() {
  if (!targetPool) targetPool = await new sql.ConnectionPool(targetConfig).connect();
  return targetPool;
}

function normalizeDate(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function normalizeDateTime(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function cleanSourceRow(row) {
  return {
    PLANEACION: String(row.PLANEACION),
    FECHA_CARGA: normalizeDate(row.FECHA_CARGA),
    PZ_PEDIDAS: Number(row.PZ_PEDIDAS || 0),
    PZ_ENVIADAS: Number(row.PZ_ENVIADAS || 0),
    ULTIMA_EDICION: normalizeDateTime(row.ULTIMA_EDICION),
    USUARIO_EDITA: row.USUARIO_EDITA == null ? null : String(row.USUARIO_EDITA),
    STATUS: row.STATUS == null ? null : String(row.STATUS)
  };
}

function sourceSignature(row) {
  return JSON.stringify([
    row.PLANEACION,
    row.FECHA_CARGA,
    row.PZ_PEDIDAS,
    row.PZ_ENVIADAS,
    row.ULTIMA_EDICION,
    row.USUARIO_EDITA,
    row.STATUS
  ]);
}

async function readSourceRows() {
  const pool = await getSourcePool();
  const request = pool.request();
  request.input("fromDate", sql.Date, process.env.SYNC_FROM_DATE || "2026-11-01");

  const result = await request.query(SOURCE_QUERY);
  const rows = result.recordset.map(cleanSourceRow);

  const seen = new Set();
  const duplicates = [];

  for (const row of rows) {
    if (seen.has(row.PLANEACION)) duplicates.push(row.PLANEACION);
    seen.add(row.PLANEACION);
  }

  if (duplicates.length) {
    throw new Error(
      `La consulta de origen devolvió PLANEACION duplicada: ${duplicates.slice(0, 10).join(", ")}`
    );
  }

  return rows;
}

async function readTargetRows() {
  const pool = await getTargetPool();
  const result = await pool.request().query(`
    SELECT
      PLANEACION,
      CONVERT(varchar(10), FECHA_CARGA, 23) AS FECHA_CARGA,
      PZ_PEDIDAS,
      PZ_ENVIADAS,
      CONVERT(varchar(33), ULTIMA_EDICION, 126) AS ULTIMA_EDICION,
      USUARIO_EDITA,
      STATUS,
      PREPARADO,
      VALIDADO,
      ACTUALIZADO_EN
    FROM dbo.PLANEACIONES
    ORDER BY PLANEACION;
  `);

  return result.recordset.map(row => ({
    ...row,
    PZ_PEDIDAS: Number(row.PZ_PEDIDAS || 0),
    PZ_ENVIADAS: Number(row.PZ_ENVIADAS || 0)
  }));
}

async function syncDifferential() {
  const sourceRows = await readSourceRows();
  const targetPool = await getTargetPool();

  const current = await targetPool.request().query(`
    SELECT
      PLANEACION,
      CONVERT(varchar(10), FECHA_CARGA, 23) AS FECHA_CARGA,
      PZ_PEDIDAS,
      PZ_ENVIADAS,
      CONVERT(varchar(33), ULTIMA_EDICION, 126) AS ULTIMA_EDICION,
      USUARIO_EDITA,
      STATUS
    FROM dbo.PLANEACIONES;
  `);

  const targetMap = new Map(
    current.recordset.map(row => [
      String(row.PLANEACION),
      {
        PLANEACION: String(row.PLANEACION),
        FECHA_CARGA: normalizeDate(row.FECHA_CARGA),
        PZ_PEDIDAS: Number(row.PZ_PEDIDAS || 0),
        PZ_ENVIADAS: Number(row.PZ_ENVIADAS || 0),
        ULTIMA_EDICION: normalizeDateTime(row.ULTIMA_EDICION),
        USUARIO_EDITA: row.USUARIO_EDITA == null ? null : String(row.USUARIO_EDITA),
        STATUS: row.STATUS == null ? null : String(row.STATUS)
      }
    ])
  );

  const sourceMap = new Map(sourceRows.map(row => [row.PLANEACION, row]));

  let nuevos = 0;
  let modificados = 0;
  let eliminados = 0;

  const tx = new sql.Transaction(targetPool);
  await tx.begin();

  try {
    for (const row of sourceRows) {
      const existing = targetMap.get(row.PLANEACION);

      if (!existing) {
        const req = new sql.Request(tx);
        req.input("PLANEACION", sql.NVarChar(100), row.PLANEACION);
        req.input("FECHA_CARGA", sql.Date, row.FECHA_CARGA);
        req.input("PZ_PEDIDAS", sql.Int, row.PZ_PEDIDAS);
        req.input("PZ_ENVIADAS", sql.Int, row.PZ_ENVIADAS);
        req.input("ULTIMA_EDICION", sql.DateTime2, row.ULTIMA_EDICION);
        req.input("USUARIO_EDITA", sql.NVarChar(100), row.USUARIO_EDITA);
        req.input("STATUS", sql.NVarChar(50), row.STATUS);

        await req.query(`
          INSERT INTO dbo.PLANEACIONES (
            PLANEACION, FECHA_CARGA, PZ_PEDIDAS, PZ_ENVIADAS,
            ULTIMA_EDICION, USUARIO_EDITA, STATUS,
            PREPARADO, VALIDADO, ACTUALIZADO_EN
          )
          VALUES (
            @PLANEACION, @FECHA_CARGA, @PZ_PEDIDAS, @PZ_ENVIADAS,
            @ULTIMA_EDICION, @USUARIO_EDITA, @STATUS,
            'Pendiente', 'Pendiente', SYSDATETIME()
          );
        `);
        nuevos++;
      } else if (sourceSignature(existing) !== sourceSignature(row)) {
        const req = new sql.Request(tx);
        req.input("PLANEACION", sql.NVarChar(100), row.PLANEACION);
        req.input("FECHA_CARGA", sql.Date, row.FECHA_CARGA);
        req.input("PZ_PEDIDAS", sql.Int, row.PZ_PEDIDAS);
        req.input("PZ_ENVIADAS", sql.Int, row.PZ_ENVIADAS);
        req.input("ULTIMA_EDICION", sql.DateTime2, row.ULTIMA_EDICION);
        req.input("USUARIO_EDITA", sql.NVarChar(100), row.USUARIO_EDITA);
        req.input("STATUS", sql.NVarChar(50), row.STATUS);

        await req.query(`
          UPDATE dbo.PLANEACIONES
          SET
            FECHA_CARGA = @FECHA_CARGA,
            PZ_PEDIDAS = @PZ_PEDIDAS,
            PZ_ENVIADAS = @PZ_ENVIADAS,
            ULTIMA_EDICION = @ULTIMA_EDICION,
            USUARIO_EDITA = @USUARIO_EDITA,
            STATUS = @STATUS,
            ACTUALIZADO_EN = SYSDATETIME()
          WHERE PLANEACION = @PLANEACION;
        `);
        modificados++;
      }
    }

    // Importante: solamente elimina registros que están dentro del conjunto
    // controlado por SYNC_FROM_DATE. Los registros anteriores se conservan.
    for (const existing of targetMap.values()) {
      const existsInSource = sourceMap.has(existing.PLANEACION);

      if (!existsInSource && existing.FECHA_CARGA >= (process.env.SYNC_FROM_DATE || "2026-11-01")) {
        const req = new sql.Request(tx);
        req.input("PLANEACION", sql.NVarChar(100), existing.PLANEACION);
        await req.query(`
          DELETE FROM dbo.PLANEACIONES
          WHERE PLANEACION = @PLANEACION;
        `);
        eliminados++;
      }
    }

    await tx.commit();
  } catch (error) {
    await tx.rollback();
    throw error;
  }

  return {
    nuevos,
    modificados,
    eliminados,
    totalOrigen: sourceRows.length,
    fecha: new Date().toISOString()
  };
}

app.get("/api/health", async (req, res) => {
  res.json({ ok: true, servicio: "control-procesos-dashboard" });
});

app.get("/api/dashboard", async (req, res) => {
  try {
    const rows = await readTargetRows();

    const summary = {
      planeaciones: rows.length,
      piezasSolicitadas: rows.reduce((s, r) => s + r.PZ_PEDIDAS, 0),
      piezasEnviadas: rows.reduce((s, r) => s + r.PZ_ENVIADAS, 0),
      porEnviar: rows.reduce((s, r) => s + Math.max(r.PZ_PEDIDAS - r.PZ_ENVIADAS, 0), 0),
      preparado: {
        pendiente: rows.filter(r => r.PREPARADO === "Pendiente").length,
        proceso: rows.filter(r => r.PREPARADO === "En proceso").length,
        completo: rows.filter(r => r.PREPARADO === "Completo").length
      },
      validado: {
        pendiente: rows.filter(r => r.VALIDADO === "Pendiente").length,
        proceso: rows.filter(r => r.VALIDADO === "En proceso").length,
        completo: rows.filter(r => r.VALIDADO === "Completo").length
      }
    };

    summary.cumplimiento = summary.piezasSolicitadas
      ? Math.min(100, Math.round((summary.piezasEnviadas / summary.piezasSolicitadas) * 100))
      : 0;

    res.json({
      ok: true,
      summary,
      rows,
      lastSync: null
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ ok: false, message: error.message });
  }
});

app.post("/api/sync", async (req, res) => {
  try {
    const result = await syncDifferential();
    res.json({ ok: true, result });
  } catch (error) {
    console.error("Error de sincronización:", error);
    res.status(500).json({ ok: false, message: error.message });
  }
});

app.patch("/api/planeaciones/:id/status", async (req, res) => {
  const id = String(req.params.id);
  const { preparado, validado } = req.body;

  const valid = ["Pendiente", "En proceso", "Completo"];

  if (
    (preparado !== undefined && !valid.includes(preparado)) ||
    (validado !== undefined && !valid.includes(validado))
  ) {
    return res.status(400).json({ ok: false, message: "Estado no válido." });
  }

  try {
    const pool = await getTargetPool();
    const request = pool.request();

    request.input("PLANEACION", sql.NVarChar(100), id);

    const sets = [];
    if (preparado !== undefined) {
      request.input("PREPARADO", sql.NVarChar(20), preparado);
      sets.push("PREPARADO = @PREPARADO");
    }
    if (validado !== undefined) {
      request.input("VALIDADO", sql.NVarChar(20), validado);
      sets.push("VALIDADO = @VALIDADO");
    }

    if (!sets.length) {
      return res.status(400).json({ ok: false, message: "No hay cambios." });
    }

    sets.push("ACTUALIZADO_EN = SYSDATETIME()");

    const result = await request.query(`
      UPDATE dbo.PLANEACIONES
      SET ${sets.join(", ")}
      WHERE PLANEACION = @PLANEACION;

      SELECT
        PLANEACION, PREPARADO, VALIDADO
      FROM dbo.PLANEACIONES
      WHERE PLANEACION = @PLANEACION;
    `);

    if (!result.recordset.length) {
      return res.status(404).json({ ok: false, message: "Planeación no encontrada." });
    }

    res.json({ ok: true, row: result.recordset[0] });
  } catch (error) {
    console.error(error);
    res.status(500).json({ ok: false, message: error.message });
  }
});

app.get("/{*splat}", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Control de Procesos disponible en http://localhost:${PORT}`);
});
