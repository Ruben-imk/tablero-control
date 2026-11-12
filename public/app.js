const state = {
  rows: [],
  filtered: []
};

const STATUS_OPTIONS = ["Pendiente", "En proceso", "Completo"];

const $ = selector => document.querySelector(selector);

document.addEventListener("DOMContentLoaded", () => {
  setOperationDate();
  setDefaultCustomDates();
  updateCustomDateVisibility();
  updateDateFilterLabel();
  bindEvents();
  loadDashboard();
});

function bindEvents() {
  $("#syncBtn").addEventListener("click", syncNow);
  $("#searchInput").addEventListener("input", renderTable);
  $("#statusFilter").addEventListener("change", renderTable);
  $("#dateFilterBtn").addEventListener("click", () => {
    $("#dateFilterPanel").classList.toggle("open");
  });
  $("#dateFilter").addEventListener("change", updateCustomDateVisibility);
  $("#applyDateFilter").addEventListener("click", () => {
    if (!validateCustomDateRange()) return;
    updateDateFilterLabel();
    $("#dateFilterPanel").classList.remove("open");
    renderTable();
  });
  $("#clearFilters").addEventListener("click", clearFilters);
}

function setOperationDate() {
  const now = new Date();
  $("#operationDate").textContent = now.toLocaleDateString("es-MX", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric"
  });
}

async function loadDashboard() {
  try {
    const response = await fetch("/api/dashboard", { cache: "no-store" });
    const data = await response.json();

    if (!data.ok) throw new Error(data.message || "No se pudo cargar el dashboard.");

    state.rows = data.rows || [];
    // El resumen inicial del servidor puede contener todo el histórico.
    // El render del cliente recalcula los KPIs usando el filtro de fecha activo.
    renderTable();
    $("#lastRefresh").textContent = new Date().toLocaleTimeString("es-MX");
  } catch (error) {
    showToast(error.message, "error");
    $("#tableBody").innerHTML = `
      <tr><td colspan="9" class="empty">
        No fue posible obtener la información. Revisa la conexión con el servidor B.
      </td></tr>`;
  }
}

async function syncNow() {
  const btn = $("#syncBtn");
  btn.disabled = true;

  try {
    showToast("Consultando servidor A y comparando cambios...", "");

    const response = await fetch("/api/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" }
    });

    const data = await response.json();

    if (!data.ok) throw new Error(data.message || "La sincronización falló.");

    await loadDashboard();

    const r = data.result;
    showToast(
      `Actualización completada: ${r.nuevos} nuevos, ${r.modificados} modificados y ${r.eliminados} eliminados.`,
      "success"
    );
  } catch (error) {
    showToast(`Error de sincronización: ${error.message}`, "error");
  } finally {
    btn.disabled = false;
  }
}

function updateSummary(summary) {
  $("#kpiPlaneaciones").textContent = formatNumber(summary.planeaciones);
  $("#kpiSolicitadas").textContent = formatNumber(summary.piezasSolicitadas);
  $("#kpiEnviadas").textContent = formatNumber(summary.piezasEnviadas);
  $("#kpiPorEnviar").textContent = formatNumber(summary.porEnviar);

  const percent = Number(summary.cumplimiento || 0);
  $("#compliancePercent").textContent = `${percent}%`;
  $("#complianceBar").style.width = `${percent}%`;

  renderStatusBars("#preparedChart", summary.preparado);
  renderStatusBars("#validatedChart", summary.validado);
}

function renderStatusBars(selector, values) {
  const total = Number(values.pendiente || 0) +
    Number(values.proceso || 0) +
    Number(values.completo || 0);

  const items = [
    { label: "Pendiente", value: Number(values.pendiente || 0), className: "pending" },
    { label: "En proceso", value: Number(values.proceso || 0), className: "process" },
    { label: "Completo", value: Number(values.completo || 0), className: "complete" }
  ];

  $(selector).innerHTML = items.map(item => {
    const width = total ? (item.value / total) * 100 : 0;
    return `
      <div class="bar-row">
        <div class="bar-label">${item.label}</div>
        <div class="bar-track">
          <div class="bar-fill ${item.className}" style="width:${width}%"></div>
        </div>
        <div class="bar-value">${item.value}</div>
      </div>
    `;
  }).join("");
}

function getFilteredRows() {
  const search = $("#searchInput").value.trim().toLowerCase();
  const status = $("#statusFilter").value;
  const dateMode = $("#dateFilter").value;

  const today = startOfDay(new Date());

  return state.rows.filter(row => {
    const haystack = [
      row.PLANEACION,
      row.USUARIO_EDITA,
      row.STATUS,
      row.PREPARADO,
      row.VALIDADO
    ].join(" ").toLowerCase();

    if (search && !haystack.includes(search)) return false;

    if (status &&
        row.PREPARADO !== status &&
        row.VALIDADO !== status) {
      return false;
    }

    const dateRange = getSelectedDateRange();
    if (dateRange) {
      const rowDate = parseLocalDate(row.FECHA_CARGA);
      if (!rowDate) return false;
      if (rowDate < dateRange.from || rowDate > dateRange.to) return false;
    }

    return true;
  });
}

function getSelectedDateRange() {
  const mode = $("#dateFilter").value;
  const today = startOfDay(new Date());

  if (mode === "all") return null;

  if (mode === "custom") {
    const from = parseLocalDate($("#dateFrom").value);
    const to = parseLocalDate($("#dateTo").value);
    if (!from || !to || from > to) return null;
    return { from, to };
  }

  const from = new Date(today);
  if (mode === "7") from.setDate(from.getDate() - 6);
  if (mode === "30") from.setDate(from.getDate() - 29);

  return { from, to: today };
}

function getDateFilteredRows() {
  const dateRange = getSelectedDateRange();
  if (!dateRange) return state.rows;

  return state.rows.filter(row => {
    const rowDate = parseLocalDate(row.FECHA_CARGA);
    return rowDate && rowDate >= dateRange.from && rowDate <= dateRange.to;
  });
}

function updateKpisFromDateFilter() {
  // Los KPIs, el cumplimiento y las barras de PREPARADO/VALIDADO
  // siempre se calculan sobre el mismo periodo seleccionado en el filtro
  // de fecha, independientemente de los filtros de estado o búsqueda.
  updateSummary(buildSummary(getDateFilteredRows()));

  const mode = $("#dateFilter").value;
  const label = mode === "today"
    ? "Planeaciones del día"
    : mode === "7"
      ? "Planeaciones últimos 7 días"
      : mode === "30"
        ? "Planeaciones últimos 30 días"
        : mode === "custom"
          ? "Planeaciones del rango"
          : "Planeaciones del periodo";

  $(".kpi-card:first-child .kpi-label").textContent = label;
}

function renderTable() {
  state.filtered = getFilteredRows();
  updateKpisFromDateFilter();

  $("#resultCount").textContent =
    `${formatNumber(state.filtered.length)} ${state.filtered.length === 1 ? "registro" : "registros"}`;

  if (!state.filtered.length) {
    $("#tableBody").innerHTML = `
      <tr><td colspan="9" class="empty">
        No hay registros que coincidan con los filtros.
      </td></tr>`;
    return;
  }

  $("#tableBody").innerHTML = state.filtered.map(row => `
    <tr>
      <td>${escapeHtml(row.PLANEACION)}</td>
      <td>${formatDate(row.FECHA_CARGA)}</td>
      <td class="number">${formatNumber(row.PZ_PEDIDAS)}</td>
      <td class="number">${formatNumber(row.PZ_ENVIADAS)}</td>
      <td>${formatDateTime(row.ULTIMA_EDICION)}</td>
      <td>${escapeHtml(row.USUARIO_EDITA || "-")}</td>
      <td>
        <span class="status-pill source">${escapeHtml(row.STATUS || "-")}</span>
      </td>
      <td>
        ${statusSelect(row.PLANEACION, "preparado", row.PREPARADO)}
      </td>
      <td>
        ${statusSelect(row.PLANEACION, "validado", row.VALIDADO)}
      </td>
    </tr>
  `).join("");

  document.querySelectorAll(".status-select").forEach(select => {
    select.addEventListener("change", onStatusChange);
  });
}

function statusSelect(id, field, value) {
  const normalized = value || "Pendiente";

  return `
    <select
      class="status-select ${statusClass(normalized)}"
      data-id="${escapeHtml(id)}"
      data-field="${field}">
      ${STATUS_OPTIONS.map(option =>
        `<option value="${option}" ${option === normalized ? "selected" : ""}>
          ${option}
        </option>`
      ).join("")}
    </select>
  `;
}

async function onStatusChange(event) {
  const select = event.target;
  const id = select.dataset.id;
  const field = select.dataset.field;
  const value = select.value;

  select.disabled = true;

  try {
    const body = {};
    body[field] = value;

    const response = await fetch(`/api/planeaciones/${encodeURIComponent(id)}/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    const data = await response.json();

    if (!data.ok) throw new Error(data.message || "No se pudo guardar el estado.");

    const row = state.rows.find(r => String(r.PLANEACION) === String(id));
    if (row) row[field === "preparado" ? "PREPARADO" : "VALIDADO"] = value;

    select.className = `status-select ${statusClass(value)}`;

    // Mantener los KPIs sobre el mismo periodo de fecha seleccionado.
    updateKpisFromDateFilter();

    showToast(`${field === "preparado" ? "Preparado" : "Validado"} actualizado.`, "success");
  } catch (error) {
    showToast(error.message, "error");
    renderTable();
  } finally {
    select.disabled = false;
  }
}

function buildSummary(rows) {
  const summary = {
    planeaciones: rows.length,
    piezasSolicitadas: rows.reduce((s, r) => s + Number(r.PZ_PEDIDAS || 0), 0),
    piezasEnviadas: rows.reduce((s, r) => s + Number(r.PZ_ENVIADAS || 0), 0),
    porEnviar: rows.reduce(
      (s, r) => s + Math.max(Number(r.PZ_PEDIDAS || 0) - Number(r.PZ_ENVIADAS || 0), 0),
      0
    ),
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

  return summary;
}

function clearFilters() {
  $("#searchInput").value = "";
  $("#statusFilter").value = "";
  $("#dateFilter").value = "today";
  setDefaultCustomDates();
  updateCustomDateVisibility();
  updateDateFilterLabel();
  renderTable();
}

function updateCustomDateVisibility() {
  const custom = $("#dateFilter").value === "custom";
  $("#customDateRange").classList.toggle("visible", custom);
  if (custom && !$("#dateFrom").value) setDefaultCustomDates();
}

function setDefaultCustomDates() {
  const today = startOfDay(new Date());
  const from = new Date(today);
  from.setDate(from.getDate() - 6);
  $("#dateFrom").value = toInputDate(from);
  $("#dateTo").value = toInputDate(today);
}

function toInputDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function validateCustomDateRange() {
  if ($("#dateFilter").value !== "custom") return true;
  const from = $("#dateFrom").value;
  const to = $("#dateTo").value;
  if (!from || !to) {
    showToast("Selecciona la fecha inicial y la fecha final.", "error");
    return false;
  }
  if (from > to) {
    showToast("La fecha inicial no puede ser mayor que la fecha final.", "error");
    return false;
  }
  return true;
}

function updateDateFilterLabel() {
  const mode = $("#dateFilter").value;
  let label = "Hoy";
  if (mode === "7") label = "Últimos 7 días";
  else if (mode === "30") label = "Últimos 30 días";
  else if (mode === "all") label = "Todas las fechas";
  else if (mode === "custom") {
    const from = formatDate($("#dateFrom").value);
    const to = formatDate($("#dateTo").value);
    label = `${from} - ${to}`;
  }
  $("#dateFilterLabel").textContent = label;
}

function statusClass(value) {
  if (value === "Completo") return "complete";
  if (value === "En proceso") return "process";
  return "pending";
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString("es-MX");
}

function formatDate(value) {
  if (!value) return "-";
  const date = parseLocalDate(value);
  if (!date) return "-";

  return date.toLocaleDateString("es-MX", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric"
  });
}

function formatDateTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";

  return date.toLocaleString("es-MX", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function parseLocalDate(value) {
  if (!value) return null;
  const parts = String(value).slice(0, 10).split("-");
  if (parts.length !== 3) return null;

  const [year, month, day] = parts.map(Number);
  return new Date(year, month - 1, day);
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

let toastTimer;

function showToast(message, type = "") {
  const toast = $("#toast");
  toast.textContent = message;
  toast.className = `toast show ${type}`;

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.className = "toast";
  }, 4000);
}
