# Verification report: css-ug

- Source PDF: `css-ug.pdf` (4 pages)
- Overall: **VERIFIED** · reviewed 18/18 · needs review 0 · not in PDF? 0
- Machine checks are not approval. Every field needs a human decision: `node scripts/review.js css-ug --by "Your Name"`

## All fields

| Field | Extracted value | PDF page | Supporting text | Status |
|---|---|---|---|---|
| Scheme name | Central Sector Scheme of Scholarship for College and University Students (PM-USP CSSS) | 1 | "CENTRALSECTORSCHEMEOFSCHOLARSHIPFORCOLLEGEAND UNIVERSITYSTUDENTS(PM-USPCSSS)" | Verified by Akshit Kumar Singh |
| Authority | Ministry of Education, Government of India | 1 | "The scholarships are awarded by Ministry of Education, Government of India on thebasis of results of Higher Secondary / Class XII Board Examination." | Verified by Akshit Kumar Singh |
| State (or ALL) | ALL | 1 | "CENTRALSECTORSCHEMEOFSCHOLARSHIPFORCOLLEGEAND UNIVERSITYSTUDENTS(PM-USPCSSS)" | Verified by Akshit Kumar Singh |
| Benefit | Rs. 12,000 to Rs. 20,000 per annum | 3 | "The rate of scholarship is Rs.12,000/-per annum at Graduation level for first threeyearsofCollegeandUniversitycoursesandRs.20,000/-perannumatPost-Graduation …" | Verified by Akshit Kumar Singh |
| Deadline | — | — | — | Not in PDF? by Akshit Kumar Singh |
| Income limit (Rs/year) | 4,50,000 | 2 | "Students with gross parental/family income uptoRs. 4.5 lakh per annum areeligible for scholarship under the scheme." | Verified by Akshit Kumar Singh |
| Categories | ALL (was GENERAL, OBC, SC, ST, MINORITY) | 1, 2 | "In case ofshortfall in the number of applications, the scholarship slots shall be interoperableamong categories (Gen, OBC, SC & ST), gender (Female, Male) an…" | Corrected by Akshit Kumar Singh |
| Course levels | UG, PG | 1 | "A maximum of82,000freshscholarshipsperannumareprovidedforpursuinggraduate/postgraduate degree in colleges and universities and for professional courses, such…" | Verified by Akshit Kumar Singh |
| Years of study | 1 (was 1, 2, 3, 4, 5) | 3 | "The rate of scholarship is Rs.12,000/-per annum at Graduation level for first threeyearsofCollegeandUniversitycoursesandRs.20,000/-perannumatPost-Graduation …" | Corrected by Akshit Kumar Singh |
| Gender | ALL | 1 | "50% of the scholarships are earmarked for girls." | Verified by Akshit Kumar Singh |
| Minimum marks (%) | — | 2 | "For renewal of scholarship in each year of study, besides getting at least 50%marks in the Annual Examination, maintenance of adequate attendance of at least…" | Not in PDF? by Akshit Kumar Singh |
| Minimum board percentile (rank) | 80 (was —) | — | — | Corrected by Akshit Kumar Singh |
| Needs disability certificate | false | — | — | Verified by Akshit Kumar Singh |
| Domicile required | false | — | — | Verified by Akshit Kumar Singh |
| Eligibility text | Students who are above 80th percentile of successful candidates in the relevant stream … | 1 | "4. EligibilityforScholarship i. Students who are above 80th percentile of successful candidates in the relevantstream from the respective Board of Examinatio…" | Verified by Akshit Kumar Singh |
| Benefits text | Rs 12,000 per year at graduation level for the first three years of college and univers… (was The rate of scholarship is Rs.12,000/- per annum at Graduation level for first three ye…) | 3 | "The rate of scholarship is Rs.12,000/-per annum at Graduation level for first threeyearsofCollegeandUniversitycoursesandRs.20,000/-perannumatPost-Graduation …" | Corrected by Akshit Kumar Singh |
| Documents text | Income certificate (needed only for fresh applicants, not for renewal). Caste and educa… (was Income certificate will be required only for the fresh applicants.) | 2 | "Students with gross parental/family income uptoRs. 4.5 lakh per annum areeligible for scholarship under the scheme. Income certificate will be required onlyf…" | Corrected by Akshit Kumar Singh |
| Process text | Apply online on the National Scholarships Portal (www.scholarships.gov.in) for both fre… (was Beneficiaries/ Applicants under the scheme must apply online in the National Scholarshi…) | 2 | "Beneficiaries/ Applicants under the scheme must apply online in the NationalScholarships Portal (www.scholarships.gov.in) for the fresh/ renewal scholarships." | Corrected by Akshit Kumar Singh |

## Next steps

1. Review: `node scripts/review.js css-ug --by "Your Name"` (shows each field with its quote and page; approve, correct, or confirm not in PDF).
2. When everything is reviewed: `node scripts/finalize.js css-ug` writes the verified record into data/schemes.json.
3. Then: `npm run ingest`.

Run these from the `server` folder. On Windows PowerShell use the `node scripts/...` form shown here: `npm run x -- --option` loses the option names.
