/**
 * Shared timezone + date-format helpers (Settings → Data).
 * Reads proxyList_app_settings_v1 so stats/community/changelog match the main list.
 */
(function (global) {
  var SETTINGS_KEY = "proxyList_app_settings_v1";
  var PARTS = ["month", "day", "year"];
  var FALLBACK_ZONES = [
    "UTC",
    "Africa/Cairo",
    "Africa/Johannesburg",
    "Africa/Lagos",
    "America/Anchorage",
    "America/Argentina/Buenos_Aires",
    "America/Bogota",
    "America/Chicago",
    "America/Denver",
    "America/Edmonton",
    "America/Halifax",
    "America/Los_Angeles",
    "America/Mexico_City",
    "America/New_York",
    "America/Phoenix",
    "America/Santiago",
    "America/Sao_Paulo",
    "America/Toronto",
    "America/Vancouver",
    "Asia/Bangkok",
    "Asia/Dubai",
    "Asia/Hong_Kong",
    "Asia/Jakarta",
    "Asia/Kolkata",
    "Asia/Manila",
    "Asia/Seoul",
    "Asia/Shanghai",
    "Asia/Singapore",
    "Asia/Tokyo",
    "Australia/Melbourne",
    "Australia/Perth",
    "Australia/Sydney",
    "Europe/Amsterdam",
    "Europe/Berlin",
    "Europe/Istanbul",
    "Europe/London",
    "Europe/Madrid",
    "Europe/Moscow",
    "Europe/Paris",
    "Europe/Rome",
    "Europe/Warsaw",
    "Pacific/Auckland",
    "Pacific/Honolulu",
  ];

  var cachedSettings = null;
  var listeners = [];

  function pad2(n) {
    var s = String(Number(n) || 0);
    return s.length < 2 ? "0" + s : s;
  }

  function normalizeOrder(raw) {
    var list = Array.isArray(raw)
      ? raw.slice()
      : String(raw || "")
          .split(",")
          .map(function (p) {
            return String(p || "").trim().toLowerCase();
          });
    var out = [];
    list.forEach(function (p) {
      if (PARTS.indexOf(p) !== -1 && out.indexOf(p) === -1) out.push(p);
    });
    PARTS.forEach(function (p) {
      if (out.indexOf(p) === -1) out.push(p);
    });
    return out.slice(0, 3);
  }

  function readSettings(override) {
    if (override && typeof override === "object") {
      cachedSettings = override;
      return cachedSettings;
    }
    if (cachedSettings) return cachedSettings;
    var raw = null;
    try {
      raw = JSON.parse(global.localStorage.getItem(SETTINGS_KEY) || "null");
    } catch (_) {
      raw = null;
    }
    cachedSettings = raw && typeof raw === "object" ? raw : {};
    return cachedSettings;
  }

  function conversionEnabled(settings) {
    var s = settings || readSettings();
    if (s.timezoneConversion === false || s.timezoneConversion === "disabled") return false;
    return true;
  }

  function detectedTimeZone() {
    try {
      var tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (tz) return String(tz);
    } catch (_) {}
    return "UTC";
  }

  function isValidTimeZone(tz) {
    if (!tz) return false;
    try {
      Intl.DateTimeFormat("en-US", { timeZone: tz }).format(new Date());
      return true;
    } catch (_) {
      return false;
    }
  }

  function activeTimeZone(settings) {
    var s = settings || readSettings();
    if (!conversionEnabled(s)) return "UTC";
    var override = String(s.timezoneOverride || "").trim();
    if (override && isValidTimeZone(override)) return override;
    return detectedTimeZone();
  }

  function dateOrder(settings) {
    var s = settings || readSettings();
    return normalizeOrder(s.dateFormatOrder || s.dateFormat);
  }

  function normalizeTimeNotation(raw) {
    var v = String(raw || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "");
    if (v === "12h" || v === "12" || v === "12-hour" || v === "12hour" || v === "ampm") return "12h";
    if (v === "24h" || v === "24" || v === "24-hour" || v === "24hour") return "24h";
    return "auto";
  }

  function timezonePrefers12Hour(tz) {
    var id = String(tz || "");
    if (!id || id === "UTC") return false;
    if (
      id === "Asia/Manila" ||
      id === "Pacific/Honolulu" ||
      id === "Pacific/Pago_Pago" ||
      id === "Pacific/Guam" ||
      id === "Pacific/Saipan" ||
      id === "America/Puerto_Rico" ||
      id === "America/Jamaica"
    ) {
      return true;
    }
    if (id.indexOf("America/") !== 0) return false;
    if (id.indexOf("America/Argentina/") === 0) return false;
    if (
      /^(America\/(Sao_Paulo|Fortaleza|Recife|Bahia|Belem|Manaus|Cuiaba|Campo_Grande|Porto_Velho|Rio_Branco|Santarem|Maceio|Araguaina|Noronha|Santiago|Punta_Arenas|Coyhaique|Bogota|Lima|Caracas|Guayaquil|Asuncion|La_Paz|Montevideo|Cayenne|Paramaribo|Mexico_City|Merida|Monterrey|Mazatlan|Chihuahua|Hermosillo|Tijuana|Bahia_Banderas|Cancun|Matamoros|Ojinaga|Ciudad_Juarez|Guatemala|Tegucigalpa|El_Salvador|Managua|Costa_Rica|Panama|Belize_City|Belize|Havana|Santo_Domingo|Port-au-Prince|Martinique|Guadeloupe|Barbados|Grenada|Dominica|St_Lucia|St_Vincent|Antigua|Cayman|Nassau|Port_of_Spain|Curacao|Aruba|Nuuk|Scoresbysund|Danmarkshavn|Thule|Miquelon))$/.test(
        id
      )
    ) {
      return false;
    }
    return true;
  }

  function timeNotationSetting(settings) {
    var s = settings || readSettings();
    return normalizeTimeNotation(s.timeNotation);
  }

  function use12Hour(settings) {
    var mode = timeNotationSetting(settings);
    if (mode === "12h") return true;
    if (mode === "24h") return false;
    return timezonePrefers12Hour(activeTimeZone(settings));
  }

  function resolvedTimeNotation(settings) {
    return use12Hour(settings) ? "12h" : "24h";
  }

  function formatClock(hour, minute) {
    var h = ((Number(hour) % 24) + 24) % 24;
    var min = pad2(minute);
    if (use12Hour()) {
      var suffix = h < 12 ? " AM" : " PM";
      var h12 = h % 12;
      if (!h12) h12 = 12;
      return h12 + ":" + min + suffix;
    }
    return pad2(h) + ":" + min;
  }

  function partsInZone(date, tz) {
    var d = date instanceof Date ? date : new Date(date);
    if (!Number.isFinite(d.getTime())) return null;
    var fmt;
    try {
      fmt = new Intl.DateTimeFormat("en-US", {
        timeZone: tz || "UTC",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
        weekday: "short",
      });
    } catch (_) {
      fmt = new Intl.DateTimeFormat("en-US", {
        timeZone: "UTC",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      });
    }
    var map = {};
    fmt.formatToParts(d).forEach(function (p) {
      if (p.type !== "literal") map[p.type] = p.value;
    });
    return {
      year: Number(map.year),
      month: Number(map.month),
      day: Number(map.day),
      hour: Number(map.hour),
      minute: Number(map.minute),
    };
  }

  function formatFromParts(year, month, day, order, opts) {
    var o = normalizeOrder(order);
    var tokens = {
      month: pad2(month),
      day: pad2(day),
      year: String(year),
    };
    if (opts && opts.short) {
      o = o.filter(function (p) {
        return p !== "year";
      });
      if (!o.length) o = ["month", "day"];
    }
    return o
      .map(function (p) {
        return tokens[p];
      })
      .join("/");
  }

  function formatCalendar(year, month, day, opts) {
    return formatFromParts(year, month, day, dateOrder(), opts);
  }

  function formatDate(date, opts) {
    var tz = activeTimeZone();
    var parts = partsInZone(date, tz);
    if (!parts) return "";
    return formatFromParts(parts.year, parts.month, parts.day, dateOrder(), opts);
  }

  function formatTime(date) {
    var tz = activeTimeZone();
    var parts = partsInZone(date, tz);
    if (!parts) return "";
    return formatClock(parts.hour, parts.minute);
  }

  function zoneAbbr(date) {
    var tz = activeTimeZone();
    var d = date instanceof Date ? date : new Date();
    try {
      var name = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        timeZoneName: "short",
      })
        .formatToParts(d)
        .filter(function (p) {
          return p.type === "timeZoneName";
        })[0];
      if (name && name.value) return name.value;
    } catch (_) {}
    return conversionEnabled() ? tz : "UTC";
  }

  function formatDateTime(date) {
    var d = date instanceof Date ? date : new Date(date);
    if (!Number.isFinite(d.getTime())) return "";
    return formatDate(d) + " " + formatTime(d) + " " + zoneAbbr(d);
  }

  function formatUtcDateId(id, opts) {
    var m = String(id || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return String(id || "");
    return formatCalendar(Number(m[1]), Number(m[2]), Number(m[3]), opts);
  }

  function formatUtcMonthId(id) {
    var m = String(id || "").trim().match(/^(\d{4})-(\d{2})$/);
    if (!m) return String(id || "");
    var year = m[1];
    var month = m[2];
    var order = dateOrder().filter(function (p) {
      return p !== "day";
    });
    if (!order.length) order = ["month", "year"];
    var tokens = { month: month, year: year };
    return order
      .map(function (p) {
        return tokens[p];
      })
      .join("/");
  }

  function formatHourLabel(hour) {
    var h = ((Number(hour) % 24) + 24) % 24;
    if (use12Hour()) {
      var suffix = h < 12 ? " AM" : " PM";
      var h12 = h % 12;
      if (!h12) h12 = 12;
      return h12 + suffix;
    }
    return pad2(h) + ":00";
  }

  var MONTH_INDEX = {
    january: 1,
    jan: 1,
    february: 2,
    feb: 2,
    march: 3,
    mar: 3,
    april: 4,
    apr: 4,
    may: 5,
    june: 6,
    jun: 6,
    july: 7,
    jul: 7,
    august: 8,
    aug: 8,
    september: 9,
    sep: 9,
    sept: 9,
    october: 10,
    oct: 10,
    november: 11,
    nov: 11,
    december: 12,
    dec: 12,
  };

  function parseLooseDate(raw) {
    var s = String(raw || "").trim();
    if (!s || s === "—") return null;
    var iso = Date.parse(s);
    if (
      Number.isFinite(iso) &&
      (/^\d{4}-\d{2}-\d{2}T/.test(s) || /Z$/i.test(s) || /[+-]\d{2}:\d{2}$/.test(s))
    ) {
      return { kind: "instant", date: new Date(iso) };
    }
    var m = s.match(
      /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?(?:\s*UTC)?$/i
    );
    if (m) {
      if (m[4] != null) {
        return {
          kind: "instant",
          date: new Date(
            Date.UTC(
              Number(m[1]),
              Number(m[2]) - 1,
              Number(m[3]),
              Number(m[4]),
              Number(m[5]),
              Number(m[6] || 0)
            )
          ),
        };
      }
      return { kind: "calendar", year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
    }
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (m) {
      return { kind: "calendar", year: Number(m[3]), month: Number(m[1]), day: Number(m[2]) };
    }
    m = s.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/);
    if (m && MONTH_INDEX[m[1].toLowerCase()]) {
      return {
        kind: "calendar",
        year: Number(m[3]),
        month: MONTH_INDEX[m[1].toLowerCase()],
        day: Number(m[2]),
      };
    }
    m = s.match(/^(\d{1,2})\s+([A-Za-z]+),?\s+(\d{4})$/);
    if (m && MONTH_INDEX[m[2].toLowerCase()]) {
      return {
        kind: "calendar",
        year: Number(m[3]),
        month: MONTH_INDEX[m[2].toLowerCase()],
        day: Number(m[1]),
      };
    }
    if (Number.isFinite(iso)) return { kind: "instant", date: new Date(iso) };
    return null;
  }

  function formatLoose(raw, opts) {
    var parsed = parseLooseDate(raw);
    if (!parsed) return String(raw == null ? "" : raw);
    if (parsed.kind === "instant") {
      if (opts && opts.dateOnly) return formatDate(parsed.date, opts);
      return formatDateTime(parsed.date);
    }
    return formatCalendar(parsed.year, parsed.month, parsed.day, opts);
  }

  function utcDateHourDate(dateId, hour) {
    var m = String(dateId || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    return new Date(
      Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(hour) || 0, 0, 0)
    );
  }

  function localDateId(date) {
    var parts = partsInZone(date || new Date(), activeTimeZone());
    if (!parts) return "";
    return parts.year + "-" + pad2(parts.month) + "-" + pad2(parts.day);
  }

  function localMonthId(date) {
    var parts = partsInZone(date || new Date(), activeTimeZone());
    if (!parts) return "";
    return parts.year + "-" + pad2(parts.month);
  }

  function listTimeZones() {
    var zones = [];
    try {
      if (typeof Intl.supportedValuesOf === "function") {
        zones = Intl.supportedValuesOf("timeZone") || [];
      }
    } catch (_) {
      zones = [];
    }
    if (!zones.length) zones = FALLBACK_ZONES.slice();
    var seen = {};
    var out = [];
    ["UTC"].concat(zones).forEach(function (z) {
      var id = String(z || "");
      if (!id || seen[id] || !isValidTimeZone(id)) return;
      seen[id] = true;
      out.push(id);
    });
    out.sort(function (a, b) {
      return a.localeCompare(b);
    });
    return out;
  }

  function zoneOptionLabel(tz) {
    var id = String(tz || "");
    var pretty = id.replace(/_/g, " ");
    var off = "";
    try {
      var part = new Intl.DateTimeFormat("en-US", {
        timeZone: id,
        timeZoneName: "shortOffset",
      })
        .formatToParts(new Date())
        .filter(function (p) {
          return p.type === "timeZoneName";
        })[0];
      if (part && part.value) off = " (" + part.value + ")";
    } catch (_) {}
    return pretty + off;
  }

  function notify() {
    listeners.forEach(function (fn) {
      try {
        fn();
      } catch (_) {}
    });
    try {
      global.dispatchEvent(new CustomEvent("proxylist-datetime-change"));
    } catch (_) {}
  }

  function refresh(settings) {
    cachedSettings = null;
    readSettings(settings || undefined);
    notify();
  }

  var api = {
    SETTINGS_KEY: SETTINGS_KEY,
    PARTS: PARTS,
    conversionEnabled: conversionEnabled,
    detectedTimeZone: detectedTimeZone,
    activeTimeZone: activeTimeZone,
    isValidTimeZone: isValidTimeZone,
    dateOrder: dateOrder,
    normalizeOrder: normalizeOrder,
    partsInZone: partsInZone,
    formatCalendar: formatCalendar,
    formatDate: formatDate,
    formatTime: formatTime,
    formatDateTime: formatDateTime,
    formatUtcDateId: formatUtcDateId,
    formatUtcMonthId: formatUtcMonthId,
    formatHourLabel: formatHourLabel,
    formatClock: formatClock,
    normalizeTimeNotation: normalizeTimeNotation,
    timezonePrefers12Hour: timezonePrefers12Hour,
    use12Hour: use12Hour,
    resolvedTimeNotation: resolvedTimeNotation,
    parseLooseDate: parseLooseDate,
    formatLoose: formatLoose,
    utcDateHourDate: utcDateHourDate,
    localDateId: localDateId,
    localMonthId: localMonthId,
    zoneAbbr: zoneAbbr,
    listTimeZones: listTimeZones,
    zoneOptionLabel: zoneOptionLabel,
    refresh: refresh,
    onChange: function (fn) {
      if (typeof fn === "function") listeners.push(fn);
    },
  };

  try {
    global.addEventListener("storage", function (ev) {
      if (ev && ev.key === SETTINGS_KEY) refresh();
    });
  } catch (_) {}

  global.ProxyListDateTime = api;
})(typeof window !== "undefined" ? window : this);
