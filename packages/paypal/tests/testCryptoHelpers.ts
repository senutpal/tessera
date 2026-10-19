import * as crypto from "node:crypto";
import * as zlib from "node:zlib";

export const TEST_PRIVATE_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDBmuZtHSolQEy3
GooZ91MypC1Jj5oYFyEfxsgouSK58uI770NH4npQMHsSHHrG+Ab/9s6AnAflamcC
y+1yNQiFvxMlLKFXBXKbnTLjputAl+w5uE8IBTfGDJhi/7PaOTOXwIXAPqOrGJeW
9YAfPUfMONidw7WBNl68tlsdH1Xk0O6SgTL5QTFpwN5Sj53qdXf8qKRY8sp7IMoE
OntCWDzRe5nFIRbH9bVn/ws1AnLbtB88Y7kDoacpQeFHoDsPSYbvt5eOyB+y0XrK
QErZf551roigPd/CoxS/Pf9VtpPpFmdf9Jr4sMIsfxuC/mB9t+vuTFtQOEmQZDU8
vc3PunHFAgMBAAECggEADHGTdnvsimfT4eRgy2eZ2sjWnzANrE4k177fWE65Yz5C
FNL0WYdQtK9SLAAe5TpqKMM/97uh7AHLnuKuTSwIl+k+pqHhuWpuOMiTO1cuU7em
6dSJ+QEjtW4u9Tlr4aDR3YdikWKsJ4I+kJ7HeahCYWdd9OOnEXEGCKleuUQtepFn
wN0k9i34q3H0dIXiNtD1EWOzAVcT1q/Y2V2QeeLAMcVonlofXs/u7PneeRYZRvCH
B19ZYJZZIJPEBVfGuG+57If4wP0LsOiOtf22zkQHBiez0EsZ14IHjJ+7hgE37rLV
frbs9CPP7YdMPtBGc1nOBpE9CXjod8ICXfgBkaQRmQKBgQDm8l+cG8ExCnXnK5Xr
dWxaSpL8Z8jMK1tetPR1Iet8GbYnR1/YSC0AlLhJjnYQxgi4d6HeryGSNSWLs4XQ
ssU29RXcCEsKchj6Q49BfkPNog2F/SohSCDML1XfOfkLCem2VhcPjaC7o6GoIGN8
m8IW/bPEs1O1N3e/9+7MU/r1fwKBgQDWm4KG2C6U0byjKtyaH0WwdDRDLx1H2Ih7
VSKGGWwExWQ8fF9uZvX5KuHnckg9zMTtvxLUGacHmKs0gHoEzYNaVG2hoQz0u4W8
J/YmTb4/GG8Jwa/JpDVHTpMDwFMzRX1jcrguAPA10paZ7UdGOKlUEzZ8yKvat/ap
HpokgtHiuwKBgQDkiVJts9Vwxy43bZ003QU1MHjVx4of6IPJa35BbyiNrQ/hPLMu
3vWRjpnzSEOzg5Tbnp8TMvEgsvENlsBD7rRUFyHjlF1V3+SxuytHH0DPe56wSf9n
4e16wRjUBpVZBB0/r1+wp3E4Xcu6CRsKE0R05egALYkXWeVplVq83hoI1wKBgCU4
7cfDoTiwtB485exZdjXnwdTRTCvU878oggduS1z8e6k+DTNR6mHgPTRujvchGBsA
ZByjomPf5/oAOqmwl5LISAebrmqYR9bdu4TjQRcifsfbb0jzEUaf60HgTs36xIfG
MwnPodpD/1kNXaphU4VAm9fC2oPiGoc0xpmEkzDXAoGBAIvjnNPfFodOzY65XzDA
ikMbQ8S1Bv7BiQ4cPNDM4x94w7e4Md1hZnDQm2PXZE+V9hQmhVrlJfKXnlS/AttN
rPJfx/9GwJsYCp8bf955vU4DmUzeoZwp2i5PFtdTbqrfer9oC8Vmhxlt5B5Ydjuo
yAb2aRjbnwqmubKx4roiTYi9
-----END PRIVATE KEY-----`;

export const TEST_CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIDIzCCAgugAwIBAgIUd1cIvzNtQlSBejtRQ3CNxO5snvgwDQYJKoZIhvcNAQEL
BQAwITEfMB0GA1UEAwwWYXBpLnNhbmRib3gucGF5cGFsLmNvbTAeFw0yNjEwMTkw
NzU2NDBaFw0zNjEwMTYwNzU2NDBaMCExHzAdBgNVBAMMFmFwaS5zYW5kYm94LnBh
eXBhbC5jb20wggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDBmuZtHSol
QEy3GooZ91MypC1Jj5oYFyEfxsgouSK58uI770NH4npQMHsSHHrG+Ab/9s6AnAfl
amcCy+1yNQiFvxMlLKFXBXKbnTLjputAl+w5uE8IBTfGDJhi/7PaOTOXwIXAPqOr
GJeW9YAfPUfMONidw7WBNl68tlsdH1Xk0O6SgTL5QTFpwN5Sj53qdXf8qKRY8sp7
IMoEOntCWDzRe5nFIRbH9bVn/ws1AnLbtB88Y7kDoacpQeFHoDsPSYbvt5eOyB+y
0XrKQErZf551roigPd/CoxS/Pf9VtpPpFmdf9Jr4sMIsfxuC/mB9t+vuTFtQOEmQ
ZDU8vc3PunHFAgMBAAGjUzBRMB0GA1UdDgQWBBSqshEVzO5GcENjNrIk6LHZ6DTC
MTAfBgNVHSMEGDAWgBSqshEVzO5GcENjNrIk6LHZ6DTCMTAPBgNVHRMBAf8EBTAD
AQH/MA0GCSqGSIb3DQEBCwUAA4IBAQA6Drk10dFcPG3287AMf8X9zK927993slFd
TfGP7NI2MGfTdlGtFoDhqxD1JdYak6qvpQeJhOZI4VAJMfd3JxWuBSRXOVsWzbP4
6KpggJ2pin799Lg3YPha6x3bx8YiDBI7xFCPi//gs1OhiFc8YpOj0sKUY9cQTGGc
pmGDyAab2L8To99IcRHfENsD5nwqBkMDs/g+Wk6zEkfLYy1PfyOWctIZtRr8usxC
YD8yaM6LhB5FBTM1+rXwK3CB37eDSitTNVACq7WgZKQwrIJ9QdBJ0j+Z0rCTcRLp
9hswC3tRBcD1ESZyCuIPLXzGULDW7uoTtAsoPFusnEBQcfmwU2N6
-----END CERTIFICATE-----`;

export const TEST_CERT_URL =
  "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42-fca2a592-7497d5a0";

export const TEST_WEBHOOK_ID = "WH-TESSERA-ESCROW-2026";

export function signWebhookPayload(params: {
  transmissionId: string;
  timestamp: string;
  webhookId: string;
  rawBody: Buffer | Uint8Array | string;
  privateKeyPem?: string;
  algorithm?: string;
  format?: "decimal" | "hex";
  customCrc?: string;
}): string {
  const privateKey = params.privateKeyPem ?? TEST_PRIVATE_KEY_PEM;
  const algo = params.algorithm ?? "RSA-SHA256";
  const buf = Buffer.isBuffer(params.rawBody)
    ? params.rawBody
    : typeof params.rawBody === "string"
      ? Buffer.from(params.rawBody, "utf8")
      : Buffer.from(params.rawBody);

  const crc = zlib.crc32(buf) >>> 0;
  const crcStr =
    params.customCrc ?? (params.format === "hex" ? crc.toString(16) : crc.toString(10));
  const msg = `${params.transmissionId}|${params.timestamp}|${params.webhookId}|${crcStr}`;

  const signer = crypto.createSign(algo);
  signer.update(msg, "utf8");
  return signer.sign(privateKey, "base64");
}

export function createSignedWebhookRequest(params: {
  transmissionId?: string;
  timestamp?: string;
  webhookId?: string;
  certUrl?: string;
  authAlgo?: string;
  rawBody: string | Buffer;
  tamperSignature?: boolean;
}): {
  headers: {
    "paypal-auth-algo": string;
    "paypal-cert-url": string;
    "paypal-transmission-id": string;
    "paypal-transmission-sig": string;
    "paypal-transmission-time": string;
  };
  rawBody: string | Buffer;
  webhookId: string;
} {
  const transmissionId = params.transmissionId ?? `tx-${crypto.randomUUID()}`;
  const timestamp = params.timestamp ?? new Date().toISOString();
  const webhookId = params.webhookId ?? TEST_WEBHOOK_ID;
  const certUrl = params.certUrl ?? TEST_CERT_URL;
  const authAlgo = params.authAlgo ?? "SHA256withRSA";

  let sig = signWebhookPayload({
    transmissionId,
    timestamp,
    webhookId,
    rawBody: params.rawBody,
  });

  if (params.tamperSignature) {
    sig = `${sig.slice(0, -4)}AAAA`;
  }

  return {
    headers: {
      "paypal-auth-algo": authAlgo,
      "paypal-cert-url": certUrl,
      "paypal-transmission-id": transmissionId,
      "paypal-transmission-sig": sig,
      "paypal-transmission-time": timestamp,
    },
    rawBody: params.rawBody,
    webhookId,
  };
}
