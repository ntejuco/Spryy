/*
 * Spryy Search Node.js backend
 *
 * Created by Nathan Tejuco
 * 
 * Last updated May 8 2017
 */

'use strict';

const 
  express = require('express'),
  request = require('request').defaults({ encoding:null}),
  bodyParser = require("body-parser"),
  fs = require('fs'),
  async = require('async'),
  queryString = require('querystring');

var vision = require('@google-cloud/vision')({
    projectId: 'spryy-166219',
    keyFilename: 'Spryy-69c3a95fb320.json'
});

const app = express();
app.set('port', process.env.PORT || 5000);
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use(bodyParser.json({ verify: verifyRequestSignature }));

// Open file containing secret keys
const credentials = JSON.parse(fs.readFileSync('credentials.js', 'utf8'));

// Extract keys from file
const 
  GOOGLE_CSE_KEY = credentials.googleCSEKey,
  GOOGLE_CSE_KEY_2 = credentials.googleCSEKey2,
  VALIDATION_TOKEN = credentials.validationToken,
  APP_SECRET = credentials.appSecret,
  PAGE_ACCESS_TOKEN = credentials.pageAccessToken,
  cloudProjectID = credentials.cloudProjectID;

// Validate Facebook webhook
app.get('/webhook', function(req, res) {
  if (req.query['hub.mode'] === 'subscribe' &&
      req.query['hub.verify_token'] === VALIDATION_TOKEN) {
    console.log("Validating webhook");
    res.status(200).send(req.query['hub.challenge']);
  } else {
    console.error("Failed validation. Make sure the validation tokens match.");
    res.sendStatus(403);          
  }  
});

app.post('/webhook', function (req, res) {
  var data = req.body;

  // Make sure this is a page subscription
  if (data.object == 'page') {
    // Iterate over each entry
    // There may be multiple if batched
    data.entry.forEach(function(pageEntry) {
      var pageID = pageEntry.id;
      var timeOfEvent = pageEntry.time;

      // Iterate over each messaging event
      pageEntry.messaging.forEach(function(messagingEvent) {
        if (messagingEvent.optin) {
          receivedAuthentication(messagingEvent);
        } else if (messagingEvent.message) {
          receivedMessage(messagingEvent);
        } else if (messagingEvent.delivery) {
          receivedDeliveryConfirmation(messagingEvent);
        } else if (messagingEvent.postback) {
          receivedPostback(messagingEvent);
        } else {
          console.log("Webhook received unknown messagingEvent: ", messagingEvent);
        }
      });
    });

    res.sendStatus(200);
  }
});

/*
 *Verify callback came from Facebook
*/
function verifyRequestSignature(req, res, buf) {
  var signature = req.headers["x-hub-signature"];

  if (!signature) {
    // For testing, let's log an error. In production, you should throw an 
    // error.
    console.error("Couldn't validate the signature.");
  } else {
    var elements = signature.split('=');
    var method = elements[0];
    var signatureHash = elements[1];

    var expectedHash = crypto.createHmac('sha1', APP_SECRET)
                        .update(buf)
                        .digest('hex');

    if (signatureHash != expectedHash) {
      throw new Error("Couldn't validate the request signature.");
    }
  }
}

function receivedMessage(event) {
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;
  var timeOfMessage = event.timestamp;
  var message = event.message;

  console.log("Received message for user %d and page %d at %d with message:", 
    senderID, recipientID, timeOfMessage);
  console.log(JSON.stringify(message));

  var isEcho = message.is_echo;
  var messageId = message.mid;
  var appId = message.app_id;
  var metadata = message.metadata;

  // Message will either contain text or attachment
  var messageText = message.text;
  var messageAttachments = message.attachments;
  var quickReply = message.quick_reply;

  if (isEcho) {
    // Logging message echoes to console
    console.log("Received echo for message %s and app %d with metadata %s", 
      messageId, appId, metadata);
    return;
  } else if (quickReply) {
  	// Should never recieve a quick reply
    var quickReplyPayload = quickReply.payload;
    console.log("Quick reply for message %s with payload %s",
      messageId, quickReplyPayload);

    sendTextMessage(senderID, "Quick reply tapped");
    return;
  }

  if (messageText) {
    searchForProductLinks(senderID, messageText);
  } else if (messageAttachments) {
  	processAttachment(senderID, messageAttachments[0]);
  }
}

function receivedDeliveryConfirmation(event) {
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;
  var delivery = event.delivery;
  var messageIDs = delivery.mids;
  var watermark = delivery.watermark;
  var sequenceNumber = delivery.seq;

  if (messageIDs) {
    messageIDs.forEach(function(messageID) {
      console.log("Received delivery confirmation for message ID: %s", 
        messageID);
    });
  }

  console.log("All message before %d were delivered.", watermark);
}

// App should not send Structured Message, so this should never be called
function receivedPostback(event) {
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;
  var timeOfPostback = event.timestamp; 
  var payload = event.postback.payload;

  console.log("Received postback for user %d and page %d with payload '%s' " + 
    "at %d", senderID, recipientID, payload, timeOfPostback);

  sendTextMessage(senderID, "Postback called");
}

function sendTextMessage(recipientId, messageText) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      text: messageText
    }
  };

  callSendAPI(messageData);
}

function callSendAPI(messageData) {
  request({
    uri: 'https://graph.facebook.com/v2.6/me/messages',
    qs: { access_token: PAGE_ACCESS_TOKEN },
    method: 'POST',
    json: messageData

  }, function (error, response, body) {
    if (!error && response.statusCode == 200) {
      var recipientId = body.recipient_id;
      var messageId = body.message_id;

      if (messageId) {
        console.log("Successfully sent message with id %s to recipient %s", 
          messageId, recipientId);
      } else {
      console.log("Successfully called Send API for recipient %s", 
        recipientId);
      }
    } else {
      console.error("Failed calling Send API", response.statusCode, response.statusMessage, body.error);
    }
  });  
}

function processAttachment(recipientID, messageAttachments){
  if (messageAttachments.type == "image"){
  	imageSearch(recipientID, messageAttachments.payload.url);
  } else {
  	sendTextMessage(recipientID, "Please send an image or the product name");
  }
}

function imageSearch(recipientID, imageSource){
  request.get(imageSource, function(err, response, body){
    if (!err && response.statusCode == 200) {
      var imageBase64 = new Buffer(body,'base64');
      var visionDetectTypes = ['logos', 'similar'];
      var options = {
  	    verbose: true,
  	    maxResults: 5,
  	    types: visionDetectTypes
	  };
      vision.detect(imageBase64, options, function(err, visionResponse, apiResponse) {
  	    if (!err) {
  	      buildSearchQuery(recipientID, visionResponse);
  	    } else {
  	      console.log("ERROR: ");
  	      console.log(err);
  	    }
      });
    }
  });
}

function buildSearchQuery(recipientID, visionResponse) {
  var searchQuery = "";
  var imageLogo = visionResponse.logos[0];
  var imageEntities = visionResponse.similar.entities;
  if (imageLogo) searchQuery += imageLogo.desc;
  if (imageEntities) {
  	for (var i=0; i < Math.min(2,imageEntities.length); i++) {
	  searchQuery += " " + imageEntities[i];
	}
  }
  console.log(searchQuery);
  searchForProductLinks(recipientID, searchQuery);
}

/*
 * Queries Google CSE, domains searched are:
 *   amazon.com
 *   ebay.com
 *	 *.myshopify.com
 * Page title and links are extracted and sent to user
 */

function searchForProductLinks(recipientID, searchQuery){
  searchQuery = queryString.escape(searchQuery);
  var options = {
    url: 'https://www.googleapis.com/customsearch/v1?key='+GOOGLE_CSE_KEY+'&cx=011733113756967906305:ptssd3i06cq&fields=items(title,link)&q='+searchQuery,
  };
  var titles = [];
  var links = [];
  request(options, function (err, res, body) {
    if (!err) {
  	  var searchItems = JSON.parse(body).items;
  	  console.log(searchItems);
  	  if (searchItems) {
  	    for (var i=0; i<Math.min(searchItems.length, 3); i++) {
  	      titles.push(searchItems[i].title);
  		  links.push(searchItems[i].link);
  		}
  	  }
  	  // if search failed to find a suitable link

  	  if (titles.length == 0) {
  	    sendTextMessage(recipientID, "Oops, we can't determine what that product is");
      } else {

      	// loop through links found and return title and address
      	getImageURL(recipientID, titles.reverse(), links.reverse());
      } 
  	} else {

  	// failed to connect to Google CSE
  	sendTextMessage(recipientID, "Oops, something went wrong on our end");
    } 
  });
}

// gets image for list template
// ༼ノಠل͟ಠ༽ノ ︵ ┻━━┻

function getImageURL(recipientID, titles, links) {
  var imageLinks = [];
  var asyncTasks = [];
  for (var i=0; i<links.length; i++) {
  	imageLinks[i] = undefined;
  }
  links.forEach(function(link,index) {
  	var searchQuery = queryString.escape(titles[index]);
    asyncTasks.push(function(callback) {
      var options = {
        url:'https://www.googleapis.com/customsearch/v1?key='+GOOGLE_CSE_KEY+'&cx=011733113756967906305:ptssd3i06cq&q='+searchQuery+'&searchType=image&alt=json'
  	  };

  	  request(options, function(err, res, body) {
        if (!err && JSON.parse(body).items != undefined 
        		&& JSON.parse(body).items.length > 0) {
          imageLinks[index] = JSON.parse(body).items[0].link;
          callback();
        } else {
          callback(err);
        }
      });
    })
  })
  async.parallel(asyncTasks, function(){
    createListTemplate(recipientID, titles, links, imageLinks);
  });
}

// build JSON for list template
function createListTemplate(recipientID, titles, links, imageLinks) {

  // build message payload JSON for each item found
  var messageElements = [];
  for (var i=0; i<titles.length; i++){
  	if (imageLinks[i] != undefined && imageLinks[i].length > 150) {
  		imageLinks[i] = undefined;
  	}
  	var item = {
  	  title: titles[i],
  	  image_url : imageLinks[i],
  	  default_action: {
  	  type: "web_url",
  	  url: links[i]
  	  },
  	  buttons: [
  	    {
  	      title: "Buy Now",
  	      type: "web_url",
  	      url: links[i]
  	    }
  	  ]
  	}
  	messageElements.push(item);
  }

  var messageData = {
  	recipient : {
  	  id: recipientID
  	},
  	message: {
  	  attachment: {
  	    type: "template",
  	    payload : {
  	      template_type : "list",
  	      top_element_style : "compact"
  	    }
  	  }
  	}
  };
  // append elements to message wrapper
  messageData.message.attachment.payload.elements = messageElements;
  callSendAPI(messageData);
}

// Start the server
app.listen(app.get('port'), function() {
  console.log('Node app is running on port', app.get('port'));
});