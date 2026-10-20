<?php
declare(strict_types=1);
// Isolated integration test, invoked only by the remote validation script.
$root=__DIR__; $folder=$root.'/google-isolated-'.bin2hex(random_bytes(6)); mkdir($folder,0700);
$env=$folder.'/.env'; file_put_contents($env,"ADMIN_PASSWORD=integration-test-password\nSESSION_SECRET=".str_repeat('s',64)."\nSITE_URL=http://localhost/seretiny\nDATA_DIR=$folder/data\nGOOGLE_PHOTOS_CLIENT_ID=test-client\nGOOGLE_PHOTOS_CLIENT_SECRET=test-client-secret\n");
putenv('SERETINY_ENV='.$env);
require $root.'/public/server/bootstrap.php';
require $root.'/public/server/media.php';
require $root.'/public/server/google.php';
function expect(bool $value,string $message): void { if (!$value) throw new RuntimeException($message); }
$calls=[];
GoogleTransport::$override=function ($url,$method,$headers,$body,$file,$limit) use (&$calls,$root) {
    $calls[]=$url;
    if (str_contains($url,'/token')) return ['access_token'=>'renewed-test-token','expires_in'=>3600];
    if (str_contains($url,'/mediaItems?')) return ['mediaItems'=>[
        ['id'=>'google-one','type'=>'PHOTO','createTime'=>'2023-07-01T23:30:00Z','mediaFile'=>['baseUrl'=>'https://lh3.googleusercontent.com/first','filename'=>'google.jpg']],
        ['id'=>'google-two','type'=>'PHOTO','createTime'=>'2023-07-02T12:00:00Z','mediaFile'=>['baseUrl'=>'https://lh3.googleusercontent.com/second','filename'=>'same.jpg']]
    ]];
    if ($file) { copy($root.'/fixtures/undated.png',$file); return []; }
    if ($method==='DELETE') return [];
    return ['id'=>'picker-session','pickerUri'=>'https://photos.google.com/picker/test','mediaItemsSet'=>true];
};
try {
    $flow=['token'=>'secret-access-token','refreshToken'=>'secret-refresh-token','expires'=>time()-1,'session'=>['id'=>'picker-session','pickerUri'=>'https://photos.google.com/picker/test','mediaItemsSet'=>true]];
    save_google($flow);
    $payload=query('SELECT payload FROM php_google_flows')->fetchColumn();
    expect(!str_contains($payload,'secret-access-token'),'Token stored in plaintext');
    expect(google_flow()['refreshToken']==='secret-refresh-token','Encrypted credentials cannot be restored');
    expect(google_token($flow)==='renewed-test-token','Token not renewed');
    $_POST=['fallback_date'=>'']; google_start();
    $view=google_tick(); expect($view['progress']['processed']===1,'First batch not processed');
    expect($view['progress']['imported']===1,'Google file not imported');
    $view=google_tick(); expect($view['progress']['status']==='done','Import not resumed from persisted progress');
    expect($view['progress']['duplicates']===1,'Duplicate bytes not detected');
    expect(count(days(true))===1 && days(true)[0]['date']==='2023-07-02','Google time zone conversion failed');
    expect(!str_contains(json_encode($view),'renewed-test-token'),'Token leaked to client view');
    foreach (['http://lh3.googleusercontent.com/x','https://attacker.invalid/x','https://googleusercontent.com.attacker.invalid/x','https://user:pass@lh3.googleusercontent.com/x'] as $url) {
        try { google_download(['type'=>'PHOTO','mediaFile'=>['baseUrl'=>$url]],'token'); throw new RuntimeException('Untrusted download accepted'); }
        catch (DomainException $e) { expect(str_contains($e->getMessage(),'invalide'),'Unexpected SSRF validation error'); }
    }
    try { google_download(['type'=>'VIDEO','mediaFile'=>['baseUrl'=>'https://lh3.googleusercontent.com/x']],'token'); throw new RuntimeException('Unprocessed video accepted'); }
    catch (DomainException $e) { expect(str_contains($e->getMessage(),'prête'),'Video processing status not checked'); }
    echo "Google: encrypted persistence, refresh, resumed imports, duplicates, time zones and URL validation passed.\n";
} finally {
    session_write_close();
    // The path was created here, directly under the isolated validation directory.
    $iterator=new RecursiveIteratorIterator(new RecursiveDirectoryIterator($folder,FilesystemIterator::SKIP_DOTS),RecursiveIteratorIterator::CHILD_FIRST);
    foreach ($iterator as $file) $file->isDir() ? rmdir($file->getPathname()) : unlink($file->getPathname());
    rmdir($folder);
}
