-- 付款凭证只能通过业务单权限访问，不能再借由订单共享图库目录被其他员工看到。
DELETE FROM gallery_images image
USING trade_customer_payment_proofs proof
WHERE image.attachment_id = proof.attachment_id;

UPDATE trade_customer_payment_proofs
SET gallery_directory_id = NULL
WHERE gallery_directory_id IS NOT NULL;

UPDATE trade_orders
SET payment_gallery_directory_id = NULL
WHERE payment_gallery_directory_id IS NOT NULL;
