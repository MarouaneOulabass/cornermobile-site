/** Answer key access. Nothing under server/, app/, lib/ or components/ may import this module. */
import { readFileSync } from "node:fs";
import path from "node:path";

export interface PlantedIssue {
  title: string;
  description: string;
  domain: string;
  severity: string;
}

export interface ExpectedOpportunity {
  title: string;
  annual_value_mad: number;
  effort: string;
}

export interface GroundTruth {
  company: string;
  issues: PlantedIssue[];
  opportunities: ExpectedOpportunity[];
}

export function loadGroundTruth(folder: string): GroundTruth {
  const data = JSON.parse(readFileSync(path.join(folder, "ground_truth.json"), "utf8"));
  return {
    company: data.company,
    issues: data.planted_issues.map((i: PlantedIssue) => ({ title: i.title, description: i.description, domain: i.domain, severity: i.severity })),
    opportunities: data.expected_opportunities.map((o: ExpectedOpportunity) => ({ title: o.title, annual_value_mad: Number(o.annual_value_mad), effort: o.effort })),
  };
}
