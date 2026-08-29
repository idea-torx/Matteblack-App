import { useState } from "react";

const COUNTRIES = [
  { code: "AF", name: "Afghanistan" }, { code: "AL", name: "Albania" }, { code: "DZ", name: "Algeria" },
  { code: "AD", name: "Andorra" }, { code: "AO", name: "Angola" }, { code: "AG", name: "Antigua and Barbuda" },
  { code: "AR", name: "Argentina" }, { code: "AM", name: "Armenia" }, { code: "AU", name: "Australia" },
  { code: "AT", name: "Austria" }, { code: "AZ", name: "Azerbaijan" }, { code: "BS", name: "Bahamas" },
  { code: "BH", name: "Bahrain" }, { code: "BD", name: "Bangladesh" }, { code: "BB", name: "Barbados" },
  { code: "BY", name: "Belarus" }, { code: "BE", name: "Belgium" }, { code: "BZ", name: "Belize" },
  { code: "BJ", name: "Benin" }, { code: "BT", name: "Bhutan" }, { code: "BO", name: "Bolivia" },
  { code: "BA", name: "Bosnia and Herzegovina" }, { code: "BW", name: "Botswana" }, { code: "BR", name: "Brazil" },
  { code: "BN", name: "Brunei" }, { code: "BG", name: "Bulgaria" }, { code: "BF", name: "Burkina Faso" },
  { code: "BI", name: "Burundi" }, { code: "CV", name: "Cabo Verde" }, { code: "KH", name: "Cambodia" },
  { code: "CM", name: "Cameroon" }, { code: "CA", name: "Canada" }, { code: "CF", name: "Central African Republic" },
  { code: "TD", name: "Chad" }, { code: "CL", name: "Chile" }, { code: "CN", name: "China" },
  { code: "CO", name: "Colombia" }, { code: "KM", name: "Comoros" }, { code: "CG", name: "Congo" },
  { code: "CR", name: "Costa Rica" }, { code: "HR", name: "Croatia" }, { code: "CU", name: "Cuba" },
  { code: "CY", name: "Cyprus" }, { code: "CZ", name: "Czech Republic" }, { code: "DK", name: "Denmark" },
  { code: "DJ", name: "Djibouti" }, { code: "DM", name: "Dominica" }, { code: "DO", name: "Dominican Republic" },
  { code: "EC", name: "Ecuador" }, { code: "EG", name: "Egypt" }, { code: "SV", name: "El Salvador" },
  { code: "GQ", name: "Equatorial Guinea" }, { code: "ER", name: "Eritrea" }, { code: "EE", name: "Estonia" },
  { code: "SZ", name: "Eswatini" }, { code: "ET", name: "Ethiopia" }, { code: "FJ", name: "Fiji" },
  { code: "FI", name: "Finland" }, { code: "FR", name: "France" }, { code: "GA", name: "Gabon" },
  { code: "GM", name: "Gambia" }, { code: "GE", name: "Georgia" }, { code: "DE", name: "Germany" },
  { code: "GH", name: "Ghana" }, { code: "GR", name: "Greece" }, { code: "GD", name: "Grenada" },
  { code: "GT", name: "Guatemala" }, { code: "GN", name: "Guinea" }, { code: "GW", name: "Guinea-Bissau" },
  { code: "GY", name: "Guyana" }, { code: "HT", name: "Haiti" }, { code: "HN", name: "Honduras" },
  { code: "HU", name: "Hungary" }, { code: "IS", name: "Iceland" }, { code: "IN", name: "India" },
  { code: "ID", name: "Indonesia" }, { code: "IR", name: "Iran" }, { code: "IQ", name: "Iraq" },
  { code: "IE", name: "Ireland" }, { code: "IL", name: "Israel" }, { code: "IT", name: "Italy" },
  { code: "JM", name: "Jamaica" }, { code: "JP", name: "Japan" }, { code: "JO", name: "Jordan" },
  { code: "KZ", name: "Kazakhstan" }, { code: "KE", name: "Kenya" }, { code: "KI", name: "Kiribati" },
  { code: "KW", name: "Kuwait" }, { code: "KG", name: "Kyrgyzstan" }, { code: "LA", name: "Laos" },
  { code: "LV", name: "Latvia" }, { code: "LB", name: "Lebanon" }, { code: "LS", name: "Lesotho" },
  { code: "LR", name: "Liberia" }, { code: "LY", name: "Libya" }, { code: "LI", name: "Liechtenstein" },
  { code: "LT", name: "Lithuania" }, { code: "LU", name: "Luxembourg" }, { code: "MG", name: "Madagascar" },
  { code: "MW", name: "Malawi" }, { code: "MY", name: "Malaysia" }, { code: "MV", name: "Maldives" },
  { code: "ML", name: "Mali" }, { code: "MT", name: "Malta" }, { code: "MH", name: "Marshall Islands" },
  { code: "MR", name: "Mauritania" }, { code: "MU", name: "Mauritius" }, { code: "MX", name: "Mexico" },
  { code: "FM", name: "Micronesia" }, { code: "MD", name: "Moldova" }, { code: "MC", name: "Monaco" },
  { code: "MN", name: "Mongolia" }, { code: "ME", name: "Montenegro" }, { code: "MA", name: "Morocco" },
  { code: "MZ", name: "Mozambique" }, { code: "MM", name: "Myanmar" }, { code: "NA", name: "Namibia" },
  { code: "NR", name: "Nauru" }, { code: "NP", name: "Nepal" }, { code: "NL", name: "Netherlands" },
  { code: "NZ", name: "New Zealand" }, { code: "NI", name: "Nicaragua" }, { code: "NE", name: "Niger" },
  { code: "NG", name: "Nigeria" }, { code: "KP", name: "North Korea" }, { code: "MK", name: "North Macedonia" },
  { code: "NO", name: "Norway" }, { code: "OM", name: "Oman" }, { code: "PK", name: "Pakistan" },
  { code: "PW", name: "Palau" }, { code: "PS", name: "Palestine" }, { code: "PA", name: "Panama" },
  { code: "PG", name: "Papua New Guinea" }, { code: "PY", name: "Paraguay" }, { code: "PE", name: "Peru" },
  { code: "PH", name: "Philippines" }, { code: "PL", name: "Poland" }, { code: "PT", name: "Portugal" },
  { code: "QA", name: "Qatar" }, { code: "RO", name: "Romania" }, { code: "RU", name: "Russia" },
  { code: "RW", name: "Rwanda" }, { code: "KN", name: "Saint Kitts and Nevis" }, { code: "LC", name: "Saint Lucia" },
  { code: "VC", name: "Saint Vincent and the Grenadines" }, { code: "WS", name: "Samoa" },
  { code: "SM", name: "San Marino" }, { code: "ST", name: "Sao Tome and Principe" },
  { code: "SA", name: "Saudi Arabia" }, { code: "SN", name: "Senegal" }, { code: "RS", name: "Serbia" },
  { code: "SC", name: "Seychelles" }, { code: "SL", name: "Sierra Leone" }, { code: "SG", name: "Singapore" },
  { code: "SK", name: "Slovakia" }, { code: "SI", name: "Slovenia" }, { code: "SB", name: "Solomon Islands" },
  { code: "SO", name: "Somalia" }, { code: "ZA", name: "South Africa" }, { code: "KR", name: "South Korea" },
  { code: "SS", name: "South Sudan" }, { code: "ES", name: "Spain" }, { code: "LK", name: "Sri Lanka" },
  { code: "SD", name: "Sudan" }, { code: "SR", name: "Suriname" }, { code: "SE", name: "Sweden" },
  { code: "CH", name: "Switzerland" }, { code: "SY", name: "Syria" }, { code: "TW", name: "Taiwan" },
  { code: "TJ", name: "Tajikistan" }, { code: "TZ", name: "Tanzania" }, { code: "TH", name: "Thailand" },
  { code: "TL", name: "Timor-Leste" }, { code: "TG", name: "Togo" }, { code: "TO", name: "Tonga" },
  { code: "TT", name: "Trinidad and Tobago" }, { code: "TN", name: "Tunisia" }, { code: "TR", name: "Turkey" },
  { code: "TM", name: "Turkmenistan" }, { code: "TV", name: "Tuvalu" }, { code: "UG", name: "Uganda" },
  { code: "UA", name: "Ukraine" }, { code: "AE", name: "United Arab Emirates" },
  { code: "GB", name: "United Kingdom" }, { code: "US", name: "United States" },
  { code: "UY", name: "Uruguay" }, { code: "UZ", name: "Uzbekistan" }, { code: "VU", name: "Vanuatu" },
  { code: "VA", name: "Vatican City" }, { code: "VE", name: "Venezuela" }, { code: "VN", name: "Vietnam" },
  { code: "YE", name: "Yemen" }, { code: "ZM", name: "Zambia" }, { code: "ZW", name: "Zimbabwe" },
];

const BLOCKED_COUNTRIES = ["US", "JP"];

type Props = {
  onClose: () => void;
  onVerified: () => void;
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  background: "var(--bg-base)",
  border: "1px solid var(--border-strong)",
  borderRadius: 6,
  color: "var(--text-primary)",
  fontSize: 14,
  outline: "none",
  boxSizing: "border-box",
};

const labelStyle: React.CSSProperties = {
  color: "var(--text-secondary)",
  fontSize: 12,
  display: "block",
  marginBottom: 4,
};

const alertStyle: React.CSSProperties = {
  background: "rgba(239, 68, 68, 0.10)",
  border: "1px solid rgba(239, 68, 68, 0.35)",
  borderRadius: 6,
  padding: "10px 14px",
  color: "#ef4444",
  fontSize: 13,
};

export function SeedanceVerificationModal({ onClose, onVerified }: Props) {
  const [fullName, setFullName] = useState("");
  const [businessName, setBusinessName] = useState("");
  const [businessEmail, setBusinessEmail] = useState("");
  const [countryCode, setCountryCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const isBlocked = BLOCKED_COUNTRIES.includes(countryCode);
  const isFormValid = fullName.trim() && businessName.trim() && businessEmail.trim() && countryCode && !isBlocked;

  const handleSubmit = async () => {
    if (!isFormValid || submitting) return;
    setSubmitting(true);
    setError("");
    try {
      const res = await fetch("/api/seedance/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          full_legal_name: fullName.trim(),
          business_name: businessName.trim(),
          business_email: businessEmail.trim(),
          country_code: countryCode,
        }),
      });
      if (res.ok) {
        onVerified();
      } else {
        let errorMessage = "Verification failed";
        try {
          const data = await res.json();
          errorMessage = data.error || data.message || errorMessage;
        } catch {
          errorMessage = `Server error (${res.status}). Please try again.`;
        }
        setError(errorMessage);
      }
    } catch (err) {
      if (err instanceof TypeError) {
        setError("Network error. Please check your connection and try again.");
      } else {
        setError(err instanceof Error ? err.message : "An unexpected error occurred. Please try again.");
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 9999,
      display: "flex", alignItems: "stretch", justifyContent: "center",
      background: "var(--bg-modal-backdrop)", backdropFilter: "blur(4px)",
    }} onClick={onClose}>
      <div style={{
        background: "var(--bg-surface)",
        borderRadius: 0,
        padding: 28,
        width: 420,
        maxWidth: "100vw",
        height: "100vh",
        maxHeight: "100vh",
        borderLeft: "1px solid var(--border-strong)",
        borderRight: "1px solid var(--border-strong)",
        overflowY: "auto",
        display: "flex",
        flexDirection: "column",
        color: "var(--text-primary)",
      }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
          <h2 style={{ margin: 0, fontSize: 18, color: "var(--text-primary)" }}>Seedance 2.0 — Business Verification</h2>
          <button type="button" onClick={onClose} style={{
            background: "none", border: "none", color: "var(--text-secondary)", cursor: "pointer", fontSize: 18, padding: 4,
          }}>&times;</button>
        </div>

        <p style={{ color: "var(--text-secondary)", fontSize: 13, marginBottom: 20, lineHeight: 1.5 }}>
          Seedance 2.0 by ByteDance requires verified business information before use.
          Please fill in your details below.
        </p>

        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div>
            <label style={labelStyle}>Full Legal Name</label>
            <input
              type="text"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="John Doe"
              style={inputStyle}
            />
          </div>

          <div>
            <label style={labelStyle}>Company / Business Name</label>
            <input
              type="text"
              value={businessName}
              onChange={(e) => setBusinessName(e.target.value)}
              placeholder="Acme Inc."
              style={inputStyle}
            />
          </div>

          <div>
            <label style={labelStyle}>Business Email</label>
            <input
              type="email"
              value={businessEmail}
              onChange={(e) => setBusinessEmail(e.target.value)}
              placeholder="john@acme.com"
              style={inputStyle}
            />
          </div>

          <div>
            <label style={labelStyle}>Country</label>
            <select
              value={countryCode}
              onChange={(e) => setCountryCode(e.target.value)}
              style={{
                ...inputStyle,
                color: countryCode ? "var(--text-primary)" : "var(--text-muted)",
                cursor: "pointer",
              }}
            >
              <option value="">Select your country</option>
              {COUNTRIES.map((c) => (
                <option key={c.code} value={c.code}>{c.name}</option>
              ))}
            </select>
          </div>

          {isBlocked && (
            <div style={alertStyle}>
              Seedance 2.0 is not available in {countryCode === "US" ? "the United States" : "Japan"} due to regional restrictions from the model provider.
            </div>
          )}

          {error && (
            <div style={alertStyle}>
              {error}
            </div>
          )}
        </div>

        <div style={{
          marginTop: 20,
          padding: "12px 14px",
          background: "var(--bg-raised)",
          borderRadius: 6,
          border: "1px solid var(--border-subtle)",
          fontSize: 12,
          color: "var(--text-muted)",
          lineHeight: 1.6,
        }}>
          <p style={{ margin: "0 0 6px" }}>By submitting, you confirm that:</p>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            <li>The information provided is truthful and accurate.</li>
            <li>This information is stored and may be reviewed by our team.</li>
            <li>This verification is required by the model provider&apos;s terms of service.</li>
          </ul>
        </div>

        <button
          type="button"
          onClick={handleSubmit}
          disabled={!isFormValid || submitting}
          style={{
            width: "100%",
            marginTop: 16,
            padding: "12px 0",
            borderRadius: 8,
            border: "none",
            fontSize: 14,
            fontWeight: 600,
            cursor: isFormValid && !submitting ? "pointer" : "not-allowed",
            background: isFormValid && !submitting ? "var(--text-primary)" : "var(--bg-raised)",
            color: isFormValid && !submitting ? "var(--bg-base)" : "var(--text-muted)",
            transition: "background 0.2s, color 0.2s",
          }}
        >
          {submitting ? "Verifying..." : "Verify & Continue"}
        </button>
      </div>
    </div>
  );
}
