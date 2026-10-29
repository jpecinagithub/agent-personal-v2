// Shared synthetic fixture data for F2 tests. Nothing here is a real
// person's data: "Test Person" and "Fixture Corp" are invented.
export const FIXTURE_PERSON = {
  full_name: "Test Person",
  email: "test.person@example.test",
  languages: [{ language: "English", level: "C1" }],
  authorisations: [{ country: "ES", status: "authorised" }],
  availability: "immediate",
  // Split 2026-10-29: search-preference fields (desired_roles,
  // locations, skills, exclusions, salary_expectations) live ONLY on
  // profiles now; they are deliberately absent from this person
  // fixture. Tests that need them put them on a profile body.
  employment: [{ id: "job-1", employer: "Fixture Corp", title: "Accountant", start: "2020-01", end: "2024-06" }],
  education: [{ id: "edu-1", institution: "Fixture University", title: "BSc Test Studies", start: "2016", end: "2020" }],
};
