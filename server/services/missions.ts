/** Missions: default interview guide (more helpers arrive with the API port). */

const DEFAULT_INTERVIEWS: [string, string][] = [
  ["dir", "Direction générale : objectifs, irritants perçus, budget et horizon de décision"],
  ["fin", "Finance : clôture, encaissement, reporting et qualité des données"],
  ["ops", "Opérations : flux principal, outils, ressaisies et exceptions"],
  ["com", "Commercial / relation client : devis, réclamations, délais de réponse"],
  ["it", "IT : systèmes, exports disponibles, contraintes de sécurité"],
];

export function defaultChecklist(): { id: string; question: string; interviewee: string | null; done: boolean; notes: string | null }[] {
  return DEFAULT_INTERVIEWS.map(([id, question]) => ({ id, question, interviewee: null, done: false, notes: null }));
}
