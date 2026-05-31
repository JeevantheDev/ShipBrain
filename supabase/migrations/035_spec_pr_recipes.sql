create table if not exists public.spec_pr_recipes (
  id text primary key,
  label text not null,
  prefix text not null,
  base_branch text not null default 'develop',
  source_branch text,
  ticket text not null,
  is_sample boolean not null default false,
  active boolean not null default true,
  sort_order integer not null default 100,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.spec_pr_recipes (id, label, prefix, base_branch, source_branch, ticket, is_sample, sort_order)
values
  (
    'test-color-change',
    'Heading color change',
    'test',
    'develop',
    null,
    '# TEST: Update checkout heading color

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
ShipBrain-codegen: handoff-only',
    true,
    10
  ),
  (
    'feature',
    'New functionality',
    'feature',
    'develop',
    null,
    '# Feature: [Feature Name]

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
ShipBrain-codegen: handoff-only',
    false,
    20
  ),
  (
    'bugfix',
    'Issue resolution',
    'bug fix',
    'develop',
    null,
    '# Bug Fix: [Bug Title]

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
ShipBrain-codegen: handoff-only',
    false,
    30
  ),
  (
    'refactor',
    'Code improvement',
    'refactor',
    'develop',
    null,
    '# Refactor: [Component/Module Name]

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
ShipBrain-codegen: handoff-only',
    false,
    40
  ),
  (
    'develop-to-prod',
    'Develop -> production',
    'release',
    'main',
    'develop',
    '# Release: Promote develop to production

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
Destination branch: main',
    false,
    50
  ),
  (
    'documentation',
    'Documentation update',
    'docs',
    'develop',
    null,
    '# Documentation: [Topic]

## Purpose
What documentation needs to be added or updated.

## Sections to Update
- [ ] README
- [ ] API documentation
- [ ] User guide
- [ ] Code comments

---
ShipBrain-codegen: handoff-only',
    false,
    60
  )
on conflict (id) do update set
  label = excluded.label,
  prefix = excluded.prefix,
  base_branch = excluded.base_branch,
  source_branch = excluded.source_branch,
  ticket = excluded.ticket,
  is_sample = excluded.is_sample,
  active = true,
  sort_order = excluded.sort_order,
  updated_at = now();

alter table public.spec_pr_recipes enable row level security;

drop policy if exists "spec pr recipes readable" on public.spec_pr_recipes;
create policy "spec pr recipes readable" on public.spec_pr_recipes
  for select using (active = true);
