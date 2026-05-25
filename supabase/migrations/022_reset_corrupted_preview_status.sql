-- Reset preview_status and preview_url to null for merged specs that are not deployed to production
-- and currently have preview_status = 'deployed'
UPDATE public.specs
SET 
  preview_status = NULL,
  preview_url = NULL,
  deployment_status = 'not_requested'
WHERE 
  base_branch = 'develop' 
  AND status = 'merged' 
  AND (release_status IS NULL OR release_status != 'deployed')
  AND preview_status = 'deployed';
