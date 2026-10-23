import crypto from "node:crypto";
import { ClearinghouseRecordSchema } from "@tessera/event-bus";
import { type SignedMandate, verifyPaymentMandate } from "@tessera/mandates";
import { describe, expect, it } from "vitest";
import { generateDemoScenarios } from "../../scripts/seedDemo.js";

describe("Demo Scenario Seeder", () => {
  it("synthesizes 25 valid institutional transactions across all risk tiers", async () => {
    const suite = generateDemoScenarios();

    expect(suite.scenarios.length).toBe(25);
    expect(suite.summary.totalTransactions).toBe(25);
    expect(suite.summary.lowRiskCount).toBe(10);
    expect(suite.summary.elevatedRiskCount).toBe(9);
    expect(suite.summary.criticalHitlCount).toBe(6);
    expect(suite.summary.totalVolumeMinorUnits).toBeGreaterThan(100000000); // > $1M

    const expectedDigest = crypto
      .createHash("sha256")
      .update(JSON.stringify(suite.scenarios.map((s) => s.record)))
      .digest("hex");
    expect(suite.summary.auditDigestSha256).toBe(expectedDigest);

    const generatedAtMs = new Date(suite.summary.generatedAt).getTime();
    for (const scenario of suite.scenarios) {
      expect(new Date(scenario.record.updatedAt).getTime()).toBeLessThan(generatedAtMs);
      expect(new Date(scenario.record.createdAt).getTime()).toBeLessThan(generatedAtMs);
      // Validate schema compliance
      const validated = ClearinghouseRecordSchema.safeParse(scenario.record);
      expect(validated.success).toBe(true);

      // Validate cryptographic AP2 signed mandate container
      const signed = scenario.signedMandate as SignedMandate<unknown> & {
        signerPublicKey: string;
      };
      expect(signed).toBeDefined();
      expect(signed.signature).toBeDefined();
      expect(signed.signerPublicKey).toBeDefined();

      const verifiedMandate = await verifyPaymentMandate(signed, {
        publicKey: signed.signerPublicKey,
      });
      expect(verifiedMandate.vct).toBe("mandate.payment.1");
      expect(verifiedMandate.payment_amount.amount).toBe(scenario.record.amount);
    }
  });
});
