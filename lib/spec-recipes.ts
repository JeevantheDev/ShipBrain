export type SpecPrRecipe = {
  id: string;
  label: string;
  prefix: string;
  baseBranch: string;
  sourceBranch?: string;
  ticket: string;
  isSample?: boolean;
  sortOrder?: number;
};

export const DEFAULT_SPEC_PR_RECIPES: SpecPrRecipe[] = [
  {
    id: "test-color-change",
    label: "Heading color change",
    prefix: "test",
    baseBranch: "develop",
    isSample: true,
    sortOrder: 10,
    ticket: `# TEST: Update checkout heading color

## Summary
Change the main checkout heading color in index.html for testing the ShipBrain E2E flow.

## Change Request
- **File:** index.html
- **Current:** color: #333 (dark gray)
- **New:** color: #0066cc (blue)

## Requirements
- [ ] Update the heading color in the CSS
- [ ] Keep existing layout unchanged
- [ ] No other file changes needed

## Acceptance Criteria
- [ ] Heading displays in new color
- [ ] No visual regressions
- [ ] Page loads correctly

## Notes
This is a simple test change to validate the full ShipBrain workflow:
1. Spec-to-PR creates Draft PR
2. Developer commits the color change
3. PR merged to develop
4. CI Monitor validates
5. Manager approves production deploy

---
ShipBrain-codegen: handoff-only`
  },
  {
    id: "feature",
    label: "New functionality",
    prefix: "feature",
    baseBranch: "develop",
    sortOrder: 20,
    ticket: `# Feature: [Feature Name]

## Summary
Brief description of the feature to be implemented.

## User Story
As a [type of user], I want [goal] so that [benefit].

## Requirements
- [ ] Requirement 1
- [ ] Requirement 2
- [ ] Requirement 3

## Acceptance Criteria
- [ ] Criteria 1
- [ ] Criteria 2
- [ ] Criteria 3

## Technical Notes
- Implementation approach
- Dependencies or integrations
- Performance considerations

---
ShipBrain-codegen: handoff-only`
  },
  {
    id: "bugfix",
    label: "Issue resolution",
    prefix: "bug fix",
    baseBranch: "develop",
    sortOrder: 30,
    ticket: `# Bug Fix: [Bug Title]

## Problem Description
Clear description of the bug and its impact.

## Steps to Reproduce
1. Step 1
2. Step 2
3. Step 3

## Expected Behavior
What should happen.

## Proposed Fix
Brief description of the solution approach.

---
ShipBrain-codegen: handoff-only`
  },
  {
    id: "refactor",
    label: "Code improvement",
    prefix: "refactor",
    baseBranch: "develop",
    sortOrder: 40,
    ticket: `# Refactor: [Component/Module Name]

## Current State
Description of the current implementation and its issues.

## Proposed Changes
- Change 1
- Change 2
- Change 3

## Benefits
- Improved maintainability
- Better performance
- Cleaner code structure

---
ShipBrain-codegen: handoff-only`
  },
  {
    id: "develop-to-prod",
    label: "Develop -> production",
    prefix: "release",
    baseBranch: "main",
    sourceBranch: "develop",
    sortOrder: 50,
    ticket: `# Release: Promote develop to production

## Summary
Create a production release PR from develop branch to main.

## Pre-release Checklist
- [ ] All features complete and tested
- [ ] CI pipeline passing on develop
- [ ] Code review completed
- [ ] Documentation updated
- [ ] No known critical bugs

## Release Notes
### New Features
- Feature 1
- Feature 2

---
ShipBrain-codegen: handoff-only
Source branch: develop
Destination branch: main`
  },
  {
    id: "documentation",
    label: "Documentation update",
    prefix: "docs",
    baseBranch: "develop",
    sortOrder: 60,
    ticket: `# Documentation: [Topic]

## Purpose
What documentation needs to be added or updated.

## Sections to Update
- [ ] README
- [ ] API documentation
- [ ] User guide
- [ ] Code comments

---
ShipBrain-codegen: handoff-only`
  }
];

export function recipeHeading(recipe: Pick<SpecPrRecipe, "ticket" | "label">) {
  return recipe.ticket.match(/^#\s+(.+)$/m)?.[1] ?? recipe.label;
}
