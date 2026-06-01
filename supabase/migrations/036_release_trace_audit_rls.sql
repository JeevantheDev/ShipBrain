-- Drop old restrictive policy for approval_events
drop policy if exists "approval own rows" on public.approval_events;

-- Allow select for all authenticated users on approval_events
create policy "approval_events select policy" on public.approval_events
  for select using (auth.role() = 'authenticated');

-- Keep write restrictions to the owner/creator
create policy "approval_events insert policy" on public.approval_events
  for insert with check (auth.uid() = actor_id);

create policy "approval_events update policy" on public.approval_events
  for update using (auth.uid() = actor_id) with check (auth.uid() = actor_id);

create policy "approval_events delete policy" on public.approval_events
  for delete using (auth.uid() = actor_id);

-- Drop old restrictive policy for release_traces
drop policy if exists "release traces own rows" on public.release_traces;

-- Allow select for all authenticated users on release_traces
create policy "release_traces select policy" on public.release_traces
  for select using (auth.role() = 'authenticated');

-- Keep write restrictions to the owner/creator
create policy "release_traces insert policy" on public.release_traces
  for insert with check (auth.uid() = user_id);

create policy "release_traces update policy" on public.release_traces
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "release_traces delete policy" on public.release_traces
  for delete using (auth.uid() = user_id);

-- Drop old restrictive policy for trace_events
drop policy if exists "trace events own rows" on public.trace_events;

-- Allow select for all authenticated users on trace_events
create policy "trace_events select policy" on public.trace_events
  for select using (auth.role() = 'authenticated');

-- Keep write restrictions to those who own the parent trace
create policy "trace_events insert policy" on public.trace_events
  for insert with check (
    exists (
      select 1 from public.release_traces rt
      where rt.id = trace_id and rt.user_id = auth.uid()
    )
  );

create policy "trace_events update policy" on public.trace_events
  for update using (
    exists (
      select 1 from public.release_traces rt
      where rt.id = trace_id and rt.user_id = auth.uid()
    )
  ) with check (
    exists (
      select 1 from public.release_traces rt
      where rt.id = trace_id and rt.user_id = auth.uid()
    )
  );

create policy "trace_events delete policy" on public.trace_events
  for delete using (
    exists (
      select 1 from public.release_traces rt
      where rt.id = trace_id and rt.user_id = auth.uid()
    )
  );
