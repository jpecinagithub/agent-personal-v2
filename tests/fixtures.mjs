// Shared synthetic fixture data for F2 tests. Nothing here is a real
// person's data: "Test Person" and "Fixture Corp" are invented.
export const FIXTURE_PERSON = {
  full_name: "Test Person",
  email: "test.person@example.test",
  languages: [{ language: "English", level: "C1" }],
  authorisations: [{ country: "ES", status: "authorised" }],
  availability: "immediate",
  exclusions: ["night shifts"],
  desired_roles: ["Finance Manager"],
  locations: ["Madrid", "Remote"],
  salary_expectations: { currency: "EUR", min: 50000, max: 70000, period: "year" },
  employment: [{ id: "job-1", employer: "Fixture Corp", title: "Accountant", start: "2020-01", end: "2024-06" }],
  education: [{ id: "edu-1", institution: "Fixture University", title: "BSc Test Studies", start: "2016", end: "2020" }],
  skills: ["accounting", "forecasting"],
};
